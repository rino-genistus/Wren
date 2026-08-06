# 01. Brain Mapping & Multi-Layer Cognition

Wren's cognitive model translates key human neuroanatomy into software modules across three distinct operational layers.

---

## 1. Biological Brain Mapping

| Biological Region | Functional Role | Wren Component / Software Mapping |
| :--- | :--- | :--- |
| **Prefrontal Cortex (PFC)** | Working memory, logical reasoning, goal management | Active Context Window & Short-Term Scratchpad Buffer |
| **Hippocampus** | Short-term episodic logging & indexing | Chronological Episode Store (`:Episode` in Neo4j) |
| **Neocortex** | Long-term semantic knowledge, concepts, facts | Vector Database + Neo4j Knowledge Graph (`:Concept`) |
| **Amygdala** | Emotional appraisal, threat detection, salience | Pre-cognitive Heuristic Evaluator & Affect Engine |
| **Global Workspace** | Conscious integration stage & attention broadcast | Central Multi-Agent Orchestrator Loop |

---

## 2. The 3-Layer Processing Hierarchy

```
               ┌─────────────────────────────────────────┐
               │    SENSORY INPUT (User / World Data)    │
               └────────────────────┬────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────┐
│ LEVEL 1: REACTIVE / REFLEXIVE LAYER (Sub-second / Pre-cognitive)      │
│ • Threat & Boundary Appraisal (Amygdala equivalent)                   │
│ • Instant Valence/Arousal Shift                                       │
│ • Hard System Interrupts (Self-preservation override)                 │
└───────────────────────────────────┬───────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────┐
│ LEVEL 2: DELIBERATIVE LAYER (Seconds / Conscious Reasoning)           │
│ • Active Working Context Assembly (Prefrontal Cortex)                 │
│ • Episodic Memory Search (Hippocampus)                                │
│ • Inner Monologue Generation (Private scratchpad before speaking)     │
│ • External Response Construction                                      │
└───────────────────────────────────┬───────────────────────────────────┘
                                    │
                                    ▼
┌───────────────────────────────────────────────────────────────────────┐
│ LEVEL 3: REFLECTIVE / META-COGNITIVE LAYER (Background / Async)       │
│ • Self-Observation & Metacognitive Critique                           │
│ • Memory Consolidation (Raw Episodes -> Generalized Semantic Concepts)│
│ • Value Alignment & Identity Graph Updates                            │
└───────────────────────────────────────────────────────────────────────┘
```