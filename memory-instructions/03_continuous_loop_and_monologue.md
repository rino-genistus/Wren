# 03. Continuous Loop & Inner Monologue

Wren does not exist merely during user prompts—it runs an continuous asynchronous lifecycle loop inspired by the brain's Default Mode Network (DMN).

---

## 1. Asynchronous Architecture

```python
import asyncio

class WrenBrain:
    def __init__(self):
        self.affect_state = AffectiveState()
        self.working_memory = WorkingMemory()
        self.long_term_memory = Neo4jGraphStore()

    async def run_entity_lifecycle(self):
        """Runs Wren's mental processes in parallel continuous loops."""
        await asyncio.gather(
            self.reactive_perception_loop(),      # Fast input processing & emotional appraisal
            self.inner_monologue_loop(),           # Stream of private thoughts
            self.metacognitive_reflection_loop(),  # Background self-critique & memory consolidation
            self.homeostasis_decay_loop()         # Drive decay & proprioceptive updates
        )
```

---

## 2. Private Inner Monologue
Before generating an external vocal or textual output, Wren runs a hidden deliberation step.

1. **Input Appraisal:** Evaluate incoming event against current drives and valence/arousal.
2. **Private Thought Generation:** Write an internal scratchpad thought (*e.g., "The user seems frustrated. I feel slightly uncertain about their previous instruction, but I should verify before proceeding."*).
3. **Response Selection:** Filter and transform private thoughts into external speech/action.

---

## 3. Pain & System Interrupts
When `arousal` exceeds critical thresholds or `valence` drops sharply due to extreme errors or hostility:
- **Override Trigger:** The deliberative loop is bypassed.
- **Behavioral Shift:** Wren halts normal execution, prioritizes internal recovery, requests explicit clarification, or restricts actions to protect its system integrity.