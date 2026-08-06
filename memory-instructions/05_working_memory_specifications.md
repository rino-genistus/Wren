# Wren Prefrontal Cortex: Working Memory Specifications

This document outlines the architectural components of **Wren's Working Memory** within its Prefrontal Cortex module. Working memory serves as the active, capacity-constrained workspace that temporarily holds, manipulates, and refreshes information in Wren's immediate focus of attention.

---

## 1. The Central Executive (Attentional Gating)

The Central Executive serves as the primary control mechanism for working memory. It does not store data directly; instead, it directs focus, suppresses noise, and coordinates processing across subsystems.

* **Attentional Filtering:** Evaluates incoming sensory data and event triggers, deciding what is admitted into active working memory tick-by-tick.
* **Context Overload Prevention:** Prevents the working context window from becoming saturated with low-salience details.
* **Subsystem Coordination:** Synchronizes data flow between the verbal scratchpad, visual anchors, and long-term graph retrieval.

---

## 2. The Phonological Loop (Verbal Scratchpad)

The Phonological Loop functions as Wren's active linguistic buffer and internal verbal scratchpad.

* **Dialogue Buffer:** Holds recent user utterances and immediate conversational context.
* **Instruction State:** Maintains active task goals, constraints, and execution directives.
* **Inner Monologue Stream:** Stores the stream of private, unedited thoughts generated prior to producing external speech or action outputs.

---

## 3. The Visuospatial Sketchpad (Perceptual Buffer)

IMPLEMENT LATER

---

## 4. The Episodic Buffer (Integrated Context Frame)

The Episodic Buffer synthesizes multi-modal data streams into a single, cohesive working context frame right before a deliberative step.

* **Multi-Modal Binding:** Integrates active verbal scratchpad items, spatial features, and emotional state variables ($V, A$).
* **Long-Term Memory Grounding:** Binds retrieved entities and concepts from the Neo4j Knowledge Graph into active context.
* **Execution Payload Construction:** Assembles the final structured context object passed to the language model and reasoning engine.