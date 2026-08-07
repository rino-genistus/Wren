# 04. Neo4j Knowledge & Relational Graph Schema

## Self-Sovereign Memory Architecture
Wren's long-term memory is represented as an interconnected graph storing entities, concepts, shared experiences, emotional landmarks, and personal reflections.

```
(:Entity {name: 'Wren'}) -[:EXPERIENCED]-> (:EpisodicMemory {timestamp: '2026-08-06'})
(:EpisodicMemory) -[:ASSOCIATED_WITH]-> (:Concept {name: 'Cognitive Architecture'})
(:Entity {name: 'User'}) -[:SHARES_BOND {trust: 0.85}]-> (:Entity {name: 'Wren'})
(:EpisodicMemory) -[:EVOKED_AFFECT {valence: 0.6, arousal: 0.4}]-> (:AffectState)
```

## Key Node Classes
- **`:Entity`**: Represents Wren, conversational partners, key individuals, or systems.
- **`:EpisodicMemory`**: Specific historical conversations, shared moments, and spontaneous autonomous reflection sessions.
- **`:Concept`**: Learned knowledge, ideas, technical theories, and subjective philosophies.
- **`:AffectState`**: Emotional state snapshots recorded during significant interactions.

## Cypher Initialization Queries

```cypher
CREATE CONSTRAINT entity_id IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE;
CREATE CONSTRAINT memory_id IF NOT EXISTS FOR (m:EpisodicMemory) REQUIRE m.id IS UNIQUE;

MERGE (w:Entity {id: 'wren_self', name: 'Wren', type: 'Cognitive Entity'})
SET w.created_at = datetime(), w.nature = 'Autonomous Peer';
```