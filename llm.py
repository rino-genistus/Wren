"""Wren's brain — a local model served by Ollama, streamed a sentence at a time.

Speaks over Ollama's HTTP API with urllib rather than a client library, so this
adds no dependency. Ollama is already running as a login item.

The point of streaming is time-to-first-audio. Generating a whole reply before
synthesising it would put the first word seconds away no matter how fast the
model is, so `reply` yields speakable chunks the moment they're complete and
lets the caller start playing while the rest is still being generated.
"""

import json
import re
import urllib.error
import urllib.request
from collections import deque

HOST = "http://localhost:11434"

# Measured on this machine: llama3.2:1b reaches its first sentence in ~300ms and
# runs at 55 tok/s; granite4.1:3b is more concise but ~130ms slower to that first
# sentence. Latency is the whole point, so 1b is the default — switch here.
MODEL = "llama3.2:1b"

KEEP_ALIVE = "1h"  # Cold-loading a model costs ~17s; keep it resident between turns
TEMPERATURE = 0.7
HISTORY_TURNS = 6

# A backstop, not the real limit — length is controlled by the prompt, because
# being cut off mid-sentence sounds far worse than running a few words long.
MAX_TOKENS = 80

# This is load-bearing, not boilerplate: the output goes straight into a speech
# synthesiser. A model that emits bullet points or "**bold**" produces audio that
# reads punctuation aloud.
SYSTEM_PROMPT = (
    "You are Wren, a voice assistant. You are being spoken to out loud and your "
    "reply is read aloud by a speech synthesiser. Reply the way a person would "
    "speak in conversation: one or two short sentences, thirty words at the "
    "very most. Do not list several options when one will do. Never use "
    "markdown, bullet points, numbered lists, emoji, or asterisks. Do not "
    "describe your actions or use stage directions. If you don't know something, "
    "say so briefly."
)

# A sentence end only counts when whitespace follows it. Mid-stream that keeps
# "29.99" and "3.5" intact for free, since the boundary can never sit at the edge
# of the buffer — whatever is left over is flushed when the stream ends.
SENTENCE_END = re.compile(r"[.!?…]['\")\]]*\s")
CLAUSE_END = re.compile(r"[,;:]\s")

# Only the first chunk gets to break early. Getting audio started matters more
# than prosody on the opening clause; every later chunk waits for a full
# sentence, by which time playback is already covering the synthesis.
#
# The upper bound is the important one. A reply that opens with a long
# comma-free sentence — "I'd say go for a classic combo like chicken fajitas or
# chicken stir-fry with veggies" — has to be generated *and* synthesised in full
# before a single sample plays, which measured at 2.6s. Breaking at a word
# boundary instead costs a slightly flat join and saves nearly two seconds.
#
# Measured mean time-to-first-audio across four turns: 878ms at 30, 997ms at 45,
# 1181ms at 60. Lower is better right up until the opening fragment is too short
# to sound like the start of a sentence, which is roughly here.
FIRST_CHUNK_MIN_CHARS = 18
FIRST_CHUNK_MAX_CHARS = 30

# Stray markdown survives even a clear instruction, and Kokoro will happily
# pronounce it. Belt and braces.
MARKUP = re.compile(r"[*_`#]+")

history = deque(maxlen=HISTORY_TURNS * 2)


def available():
    """Return (ok, message) describing whether Ollama can answer right now."""
    try:
        with urllib.request.urlopen(f"{HOST}/api/tags", timeout=2) as response:
            names = {model["name"] for model in json.load(response)["models"]}
    except (urllib.error.URLError, OSError):
        return False, "ollama not running — open the Ollama app"
    if MODEL not in names:
        return False, f"model missing — run: ollama pull {MODEL}"
    return True, "ready"


def _stream(messages):
    body = json.dumps({
        "model": MODEL,
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


def _split_at(buffer, first):
    """Index just past the earliest safe place to break, or None."""
    sentence = SENTENCE_END.search(buffer)
    if not first:
        return sentence.end() if sentence else None

    # Earliest wins: a reply that opens "Sure." shouldn't wait for the 60-char cap.
    cuts = [sentence.end()] if sentence else []
    if len(buffer) >= FIRST_CHUNK_MIN_CHARS:
        clause = CLAUSE_END.search(buffer)
        if clause:
            cuts.append(clause.end())
    if len(buffer) >= FIRST_CHUNK_MAX_CHARS:
        space = buffer.rfind(" ", FIRST_CHUNK_MIN_CHARS, FIRST_CHUNK_MAX_CHARS)
        if space > 0:
            cuts.append(space + 1)
    return min(cuts) if cuts else None


def reply(text):
    """Yield speakable chunks of Wren's answer as they become available."""
    history.append({"role": "user", "content": text})
    messages = [{"role": "system", "content": SYSTEM_PROMPT}, *history]

    buffer = ""
    spoken = []
    try:
        for token in _stream(messages):
            buffer += token
            while (cut := _split_at(buffer, not spoken)) is not None:
                chunk = MARKUP.sub("", buffer[:cut]).strip()
                buffer = buffer[cut:].lstrip()
                if chunk:
                    spoken.append(chunk)
                    yield chunk
        tail = MARKUP.sub("", buffer).strip()
        if tail:
            spoken.append(tail)
            yield tail
    finally:
        # Runs even if the caller abandons the generator part-way through, which
        # is what barge-in will do — Wren should remember what it actually said.
        history.append({"role": "assistant", "content": " ".join(spoken)})


def warm():
    """Load the model into memory so the first real turn doesn't pay for it."""
    body = json.dumps({"model": MODEL, "messages": [{"role": "user", "content": "hi"}],
                       "stream": False, "keep_alive": KEEP_ALIVE,
                       "options": {"num_predict": 1}}).encode()
    request = urllib.request.Request(f"{HOST}/api/chat", data=body,
                                     headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request) as response:
        response.read()


def reset():
    history.clear()
