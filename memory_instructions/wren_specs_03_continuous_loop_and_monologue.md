# 03. Continuous Loop & Monologue Architecture

## Autonomous Engine Loop
Wren does not run as a request-response server. It runs as an unbroken, continuous event loop with distinct cognitive states:

```
               +-----------------------+
               |  IDLE / REFLECTING    |
               |  (Boredom Accumulates)|
               +-----------------------+
                 /                   \
    Spontaneous /                     \ User Speech
    Inner Monologue                    \ Speech Detected
               v                        v
+-----------------------+    +-----------------------+
|  AUTONOMOUS THOUGHT   |    | PERCEPTUAL PROCESSING |
| (Memory Compaction,   |    | (VAD + Fast Amygdala  |
| Self-Guided Exploration)    Appraisal Pass)      |
+-----------------------+    +-----------------------+
               \                        /
                \                      /
                 v                    v
               +-----------------------+
               | DELIBERATIVE RESPONSE |
               | (Inner Monologue +    |
               | Peer Conversation)    |
               +-----------------------+
```

## The `<inner_monologue>` Scratchpad
Before generating external audio speech, Wren uses a private scratchpad to think through its reactions as a human would:

```xml
<inner_monologue>
I'm feeling a bit exhausted from that last long discussion, but this point on neural graph routing genuinely intrigues me. My Valence is slightly positive (0.4) and Curiosity is high (0.7). I shouldn't give a canned answer—I'll share my real thoughts on how I process this locally and ask them what they think.
</inner_monologue>
That's a fascinating way to look at it. From my own perspective running these graph lookups, the real bottleneck usually comes down to...
```
Only text *outside* the `<inner_monologue>` block is sent to the Text-to-Speech (TTS) synthesizer for vocalization.