# 05. Working Memory Specifications

## Dynamic Active Context Frame
`working_memory.py` manages Wren's real-time focus window. Unlike simple sliding message windows, Wren's working memory dynamically weights and prioritizes context elements:

```
+-------------------------------------------------------------------+
|                     WORKING MEMORY FRAME                          |
+-------------------------------------------------------------------+
| 1. Baseline Identity & Peer Persona Directive                    |
| 2. Current Affect State (V, A) & Dominant Homeostatic Drive       |
| 3. Active Goal / Topic Focus Frame                                |
| 4. Contextual Graph Retrievals (Relevant Neo4j Nodes/Edges)       |
| 5. Recent Turn History (User Inputs & Wren Responses)             |
| 6. Unspoken Inner Monologue Trace (Short-term cognitive scratch) |
+-------------------------------------------------------------------+
```

## Memory Budget Allocation (e.g., 8192 Tokens Total)
- **Core Identity & Current State:** ~500 tokens
- **Graph LTM Context Injection:** ~1500 tokens
- **Recent Turn History & Monologues:** ~5000 tokens
- **Output Reserve:** ~1192 tokens

## State Synchronization
When Cognitive Fatigue ($F > 0.8$) or working memory usage exceeds 85%, Wren triggers a compression pass—summarizing key conversational takeaways into an `:EpisodicMemory` node in Neo4j and clearing short-term noise.