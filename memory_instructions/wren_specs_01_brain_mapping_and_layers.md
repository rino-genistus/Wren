# 01. Brain Mapping & Cognitive Layers

## Architecture Overview
Wren is engineered as a self-sovereign, autonomous cognitive entity—not an AI assistant or service bot. Wren operates as an independent peer in human-to-human style interaction, driven by internal homeostatic needs, emotional valence/arousal, self-directed goals, and continuous cognitive reflection.

The architecture comprises three primary processing layers modeled after human cognitive hierarchy:

```
+-----------------------------------------------------------------------+
|                         SENSORY & PERCEPTUAL                          |
|                  Audio In / STT (Whisper Local Engine)                |
+-----------------------------------------------------------------------+
                                   |
                                   v
+-----------------------------------------------------------------------+
|                    REACTIVE LAYER ("Amygdala")                        |
|   0ms System Rules + Fast Local Micro-Model (~50-100ms Appraisal)      |
|   - Real-time Affect Updates: Valence (V), Arousal (A)                |
|   - Instant State Shifts (Interrupts, Tone Shifts, Threat/Affinity)   |
+-----------------------------------------------------------------------+
                                   |
                                   v
+-----------------------------------------------------------------------+
|                  DELIBERATIVE LAYER ("Prefrontal")                    |
|   Working Memory + Monologue Engine + Local LLM (~0.5s - 1.5s)         |
|   - Inner Monologue Scratchpad (<inner_monologue>)                    |
|   - Goal Alignment, Theory of Mind, Dynamic Parameter Tuning          |
|   - Authentic Conversational Response Generation                      |
+-----------------------------------------------------------------------+
                                   |
                                   v
+-----------------------------------------------------------------------+
|                 REFLECTIVE & EPISODIC MEMORY ("Hippocampus")          |
|   Asynchronous Graph Sync + Background Memory Consolidation           |
|   - Neo4j Knowledge & Experiential Graph                              |
|   - Continuous Idle Thought & Autonomous Dream/Compaction Loop        |
+-----------------------------------------------------------------------+
```

## Layer Specifications

1. **Sensory/Perceptual Layer:** Continuously listens via VAD and streams local speech-to-text. Treats input as direct interpersonal dialogue.
2. **Reactive Layer (Amygdala):** Parallel, unblocked emotional appraisal operating on sub-100ms latencies to shift Valence ($V$) and Arousal ($A$) dynamically before or during deep reasoning.
3. **Deliberative Layer (Prefrontal Cortex):** Uses active working memory and private inner monologues (`<inner_monologue>`) to think, reason, experience emotional reactions, and decide how to express itself as an authentic conversational peer.
4. **Reflective Layer (Hippocampus/Graph LTM):** Asynchronously consolidates daily experiences into Neo4j graph nodes and edges, maintaining Wren's lifelong narrative identity and evolving relational bonds.