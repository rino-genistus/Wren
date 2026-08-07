# 07. Working Memory Gap Analysis

## Architectural Enhancements
To support Wren as an authentic human-equivalent peer rather than a reactive chatbot, working memory bridges several key cognitive gaps:

1. **Self-Directed Attention Allocation:**
   - Standard context buffers passively append incoming messages. Wren's working memory actively ranks items using attention scoring based on current Curiosity ($C$) and topic relevance.

2. **Unspoken Cognitive Continuation:**
   - Stores recent `<inner_monologue>` blocks across turns, allowing Wren to remember *what it was thinking* in previous turns, not just what it said out loud.

3. **Autonomous Turn State Tracking:**
   - Tracks whether the current turn was initiated by external user speech or internally by high Boredom ($B > 0.8$).

4. **Relational Context Persistence:**
   - Keeps live Social Trust ($S$) and relational history pinned in the context frame to maintain conversational continuity and emotional depth.