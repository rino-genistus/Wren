"""Wren's brain — a local model, streamed a sentence at a time.

The point of streaming is time-to-first-audio. Generating a whole reply before
synthesising it would put the first word seconds away no matter how fast the
model is, so `reply` yields speakable chunks the moment they're complete and
lets the caller start playing while the rest is still being generated.

Two backends, same model weights. MLX runs it in-process; Ollama runs it in its
own server over HTTP. MLX is the default because it generates roughly 3.4x
faster — 5.0ms per token against 18ms — which is what decides when the first
speakable chunk is ready. Their time to the *first* token is a wash at ~180ms,
so switching back is only a small regression, not a broken Wren.
"""

import json
import re
import time
import urllib.error
import urllib.request
from collections import deque


BACKEND = "mlx"  # "mlx" | "ollama"

# 3B, not 1B. The 1B is ~450ms faster to its first speakable chunk but fills gaps
# in its knowledge by inventing things — asked for a film it produced a plausible
# title that does not exist. The 3B says it isn't sure instead, which is the
# difference between sounding like a person and sounding like a toy. Most of the
# latency is hidden by the filler in tts.py, which now covers the gap.
# ...-1B-Instruct-4bit is still on disk if you want the faster, thinner version.
MLX_MODEL = "mlx-community/Llama-3.2-3B-Instruct-4bit"
OLLAMA_MODEL = "llama3.2:1b"
MODEL = MLX_MODEL if BACKEND == "mlx" else OLLAMA_MODEL

HOST = "http://localhost:11434"
KEEP_ALIVE = "1h"  # Ollama only: cold-loading costs ~17s, so keep it resident
# 0.7 let the register wander — the model would drift into folksy American idiom
# a few turns into a conversation. Lower keeps it consistent across a session.
TEMPERATURE = 0.4
# Every token in the prompt costs ~1.33ms of prefill on the 3B, and history runs
# ~54 tokens a turn. Six turns was ~145ms of latency on every reply, spent
# remembering exchanges a spoken conversation almost never refers back to.
HISTORY_TURNS = 4
REPETITION_PENALTY = 1.15
REPETITION_CONTEXT = 40

# A backstop only — MAX_SENTENCES is the real limit, because cutting on a token
# count lands mid-word while cutting on a sentence boundary is inaudible.
MAX_TOKENS = 80

# The prompt asks for one or two sentences and a 1B model does not reliably
# comply: asking politely produced 7.1s replies, which is a monologue, not a
# conversation. Stop consuming the stream once two sentences have been spoken.
MAX_SENTENCES = 2

# Two sentences is not a length bound — one run-on sentence reached 15s of
# speech while technically obeying MAX_SENTENCES. Both limits stop at a chunk
# boundary, which is a natural pause, so neither is audible as a cut-off.
# Kokoro speaks roughly 16 characters per second, so this is about 8s of speech:
# a ceiling on the worst case rather than a target. Reply length is mostly the
# model's temperament and varies a lot run to run; lower this if it rambles.
MAX_REPLY_CHARS = 140

# This is load-bearing, not boilerplate: the output goes straight into a speech
# synthesiser. A model that emits bullet points or "**bold**" produces audio that
# reads punctuation aloud.
SYSTEM_PROMPT = (
    "You are Wren. This is a spoken conversation read aloud, so write only what "
    "should be said. Plain British English, one or two short sentences, then stop. "
    "Begin with a short sentence. "
    "No filler (\"you know\", \"I guess\", \"I suppose\", \"well\", \"or something\"), "
    "no slang, no markdown or lists. Do not perform a personality or describe your "
    "own actions. Say plainly if you do not know. "
    "You cannot look anything up: no clock, calendar, location, weather or internet. "
    "Say so briefly when asked about those, then answer everything else normally "
    "from what you know. "
    "Never comment on how your name was said or spelled; just answer."
)
# The previous version opened with "reply the way a person would speak in
# conversation", which invited exactly the verbal tics it was meant to avoid —
# the model filled its answers with "you know" and folksy idiom, then read them
# in a British accent. Naming the register and banning filler explicitly, and
# dropping the temperature, took measured tics from 1-per-8-replies to zero.
#
# The last two sentences are each answering an observed failure. Asked "how's the
# weather?" Wren invented "quite overcast today", then contradicted itself the
# next turn — it has no way to know and needs telling. And asked by someone who
# said "Ren", it replied "I'm Wren, not Ren." twice in a row instead of
# answering; the transcript is the ASR's spelling, not something to correct.
#
# "Begin with a short sentence" is also a latency instruction: the opening
# sentence has to be generated and synthesised before any audio plays, so its
# length sets time-to-first-audio.

# A sentence end only counts when whitespace follows it. Mid-stream that keeps
# "29.99" and "3.5" intact for free, since the boundary can never sit at the edge
# of the buffer — whatever is left over is flushed when the stream ends.
SENTENCE_END = re.compile(r"[.!?…]['\")\]]*\s")
CLAUSE_END = re.compile(r"[,;:]\s")

# Every chunk is a whole sentence where possible, including the first one.
# Cutting mid-sentence used to happen here, at 14-24 characters, to get audio
# started sooner — but the synthesiser phonemises whatever it is handed as a
# complete utterance, so the last word of the fragment came out stressed as
# though the sentence ended there. tts.py now makes that cut itself, in phoneme
# space, where it can cut without changing how anything is pronounced. What is
# needed from here is a whole sentence to phonemise.
#
# The fallback exists because "wait for a whole sentence" has no upper bound: an
# unusually long opening sentence would hold back the first sample for as long as
# it took to generate. Once a clause is in hand, wait this much longer for the
# sentence to finish, then give up and speak the clause. A comma is a far better
# place to break than mid-phrase, and this only fires on the slow tail.
FIRST_CHUNK_MIN_CHARS = 14
FIRST_SENTENCE_GRACE = 0.25

# Stray markdown survives even a clear instruction, and Kokoro will happily
# pronounce it. Belt and braces.
MARKUP = re.compile(r"[*_`#]+")

history = deque(maxlen=HISTORY_TURNS * 2)


_mlx = None


def _get_mlx():
    """Load the weights once, into this process, and keep them there.

    Whichever thread calls this first owns the model: MLX gives each thread its
    own stream and will not run a model from a thread it wasn't loaded on. Wren
    therefore warms this from the responder thread, which is the only one that
    ever generates. Calling it from anywhere else first would strand it there.
    """
    global _mlx
    if _mlx is None:
        from mlx_lm import load
        _mlx = load(MLX_MODEL)
    return _mlx


def _stream_mlx(messages):
    from mlx_lm import stream_generate
    from mlx_lm.sample_utils import make_logits_processors, make_sampler
    model, tokenizer = _get_mlx()
    prompt = tokenizer.apply_chat_template(messages, add_generation_prompt=True,
                                           tokenize=False)
    sampler = make_sampler(temp=TEMPERATURE)
    # A 1B model at 4-bit falls into loops once a few turns of history are in
    # front of it — "of course, of course, of course" — and a loop is far more
    # obvious spoken aloud than written down. Ollama applies a penalty by
    # default; mlx-lm does not, so ask for one explicitly.
    processors = make_logits_processors(repetition_penalty=REPETITION_PENALTY,
                                        repetition_context_size=REPETITION_CONTEXT)
    for response in stream_generate(model, tokenizer, prompt, max_tokens=MAX_TOKENS,
                                    sampler=sampler, logits_processors=processors):
        if response.text:
            yield response.text


def _stream_ollama(messages):
    body = json.dumps({
        "model": OLLAMA_MODEL,
        "messages": messages,
        "stream": True,
        "keep_alive": KEEP_ALIVE,
        "options": {"num_predict": MAX_TOKENS, "temperature": TEMPERATURE},
    }).encode()
    request = urllib.request.Request(f"{HOST}/api/chat", data=body,
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request) as response:
        for line in response:
            token = json.loads(line).get("message", {}).get("content", "")
            if token:
                yield token


def _stream(messages):
    return _stream_mlx(messages) if BACKEND == "mlx" else _stream_ollama(messages)


def available():
    """Return (ok, message) describing whether the model can answer right now."""
    if BACKEND == "mlx":
        # Deliberately does not load the model — that would bind it to whichever
        # thread asked, and only the responder thread may own it. Just confirm
        # the weights are on disk.
        from huggingface_hub import snapshot_download
        try:
            snapshot_download(MLX_MODEL, local_files_only=True)
        except Exception:
            return False, f"weights missing — run: hf download {MLX_MODEL}"
        return True, "ready (in-process)"
    try:
        with urllib.request.urlopen(f"{HOST}/api/tags", timeout=2) as response:
            names = {model["name"] for model in json.load(response)["models"]}
    except (urllib.error.URLError, OSError):
        return False, "ollama not running — open the Ollama app"
    if OLLAMA_MODEL not in names:
        return False, f"model missing — run: ollama pull {OLLAMA_MODEL}"
    return True, "ready (ollama)"


def _split_at(buffer, first, clause_ready):
    """Index just past the earliest safe place to break, or None.

    A sentence end is always a good break. On the first chunk only, a clause end
    is accepted too — but not immediately: `clause_ready` is when one first
    appeared, and it only wins once the sentence has failed to arrive within
    FIRST_SENTENCE_GRACE of it. That way a reply whose opening sentence finishes
    promptly is spoken whole, and only a long-winded one gets broken at a comma.
    """
    sentence = SENTENCE_END.search(buffer)
    if sentence:
        return sentence.end()
    if not first or clause_ready is None:
        return None
    if time.monotonic() - clause_ready < FIRST_SENTENCE_GRACE:
        return None
    clause = CLAUSE_END.search(buffer)
    return clause.end() if clause else None


def _clause_at(buffer):
    """Whether the buffer holds a usable clause break yet."""
    return (len(buffer) >= FIRST_CHUNK_MIN_CHARS
            and CLAUSE_END.search(buffer) is not None)


def sentences(text):
    """Split spoken text into whole sentences, for display.

    The chunks `reply` yields are sized for time-to-first-audio, not for
    reading — the opening one is cut at a word boundary mid-clause. Printing
    them directly showed Wren's answer as fragments. This regroups them.
    """
    parts = re.split(r"(?<=[.!?…])\s+", text.strip())
    return [part for part in parts if part]


def reply(text):
    """Yield speakable chunks of Wren's answer as they become available."""
    history.append({"role": "user", "content": text})
    messages = [{"role": "system", "content": SYSTEM_PROMPT}, *history]

    buffer = ""
    spoken = []
    sentences = 0
    clause_ready = None  # When the opening sentence first offered a fallback break

    def affordable(chunk):
        """Would speaking this chunk take the reply past its budget?

        Checked *before* speaking, because checking afterwards let a single long
        closing sentence overshoot by 50% and run to 11s. The first chunk is
        always affordable however long it is, so Wren never answers with nothing.
        """
        return not spoken or sum(map(len, spoken)) + len(chunk) <= MAX_REPLY_CHARS

    try:
        for token in _stream(messages):
            buffer += token
            if not spoken and clause_ready is None and _clause_at(buffer):
                clause_ready = time.monotonic()
            while (cut := _split_at(buffer, not spoken, clause_ready)) is not None:
                chunk = MARKUP.sub("", buffer[:cut]).strip()
                buffer = buffer[cut:].lstrip()
                if not chunk:
                    continue
                if not affordable(chunk):
                    return
                spoken.append(chunk)
                yield chunk
                if chunk.endswith((".", "!", "?", "…")):
                    sentences += 1
            if sentences >= MAX_SENTENCES:
                # Enough said. Abandoning the stream here is free — the tokens we
                # would have generated are ones Wren was never going to speak.
                return
        # Whatever is left when the stream ends. This is the *usual* path for a
        # reply's final sentence — it has no trailing whitespace for SENTENCE_END
        # to match — so it needs the budget check just as much as the rest.
        tail = MARKUP.sub("", buffer).strip()
        if tail and affordable(tail):
            spoken.append(tail)
            yield tail
    finally:
        # Runs even if the caller abandons the generator part-way through, which
        # is what barge-in will do — Wren should remember what it actually said.
        history.append({"role": "assistant", "content": " ".join(spoken)})


def warm():
    """Build the graph now so the first real turn doesn't pay for it."""
    messages = [{"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": "hi"}]
    for _ in _stream(messages):
        break


def reset():
    history.clear()
