# 08. Wren End-to-End Execution Loop Map

```
======================================================================================
STAGE 1: SENSORY PERCEPTION & AMYGDALA (Sub-100ms)
======================================================================================
  [User Speech Input]
         │
         ▼
  [Whisper Local STT] ──> Audio Transcript Generated
         │
         ├───> [Fast Amygdala Appraisal Task (Async Unblocked)]
         │        └── Evaluates (ΔV, ΔA) via sub-2B Micro-Model / Hardcoded Rules
         │        └── Updates `affect.py` state in real time
         │
         ▼
======================================================================================
STAGE 2: WORKING MEMORY & CONTEXT BINDING (~50ms)
======================================================================================
  `working_memory.py` assembles prompt context:
   ├─ Core Self-Sovereign Identity Directive
   ├─ Current Affect Vectors (V, A) & Drives (F, C, S, B, E)
   ├─ Relevant Neo4j Graph Subgraph (LTM Context)
   ├─ Unspoken Monologue History + Conversation Turns
   └─ User Input Transcript

======================================================================================
STAGE 3: DELIBERATIVE REASONING & MONOLOGUE (~500ms - 1200ms)
======================================================================================
  `llm.py` generates full output stream:
   ├─ Phase A: <inner_monologue>...</inner_monologue>
   │   └── Evaluates mood, thought process, peer perspective, and response strategy.
   │
   └─ Phase B: External Spoken Response
       └── Spoken naturally as an authentic peer.

======================================================================================
STAGE 4: VOCALIZATION & TELEMETRY
======================================================================================
  ├─ Audio Stream: Text OUTSIDE <inner_monologue> piped immediately to Local TTS Engine
  └─ Telemetry (fd 3): Emits affect, drive state, and inner monologue to UI visualizer

======================================================================================
STAGE 5: REFLECTION & GRAPH CONSOLIDATION (Background Idle Loop)
======================================================================================
  When Idle (Boredom > 0.8 or Idle Timer Triggered):
   └── Async background worker compacts working memory into Neo4j Episodic Nodes.
======================================================================================
```