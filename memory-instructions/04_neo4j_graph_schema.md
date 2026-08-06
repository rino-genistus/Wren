# 04. Neo4j Knowledge Graph Schema

Wren uses a **single unified Neo4j database** to store its complete personal ontology, episodic memories, emotional states, and conceptual knowledge network.

---

## 1. Architecture Overview
- **Database Count:** 1 Database (Unified graph traversals enable linking emotions directly to recalled memories).
- **Node Labels:**
  1. `:Entity` - Participants (User, Wren self).
  2. `:AffectState` - Snapshots of Wren's emotional state ($V, A$, drives) at specific timestamps.
  3. `:Episode` - Individual interactions and experiences (raw inputs, private thoughts, responses).
  4. `:Concept` - Extracted semantic facts, objects, and abstract knowledge.
  5. `:WorkingMemory` - Active short-term ring buffer of current goals and focal items.
  6. `:Action` - Tool calls, physical executions, or external decisions.

---

## 2. Visual Graph Relationship Schema

```
                          ┌───────────────────────────┐
                          │       (:AffectState)      │
                          │   Valence, Arousal, Drives│
                          └─────────────┬─────────────┘
                                        │ (WAS_IN_STATE)
                                        ▼
┌───────────────────┐  (TRIGGERED_BY) ┌───────────────────┐  (STORED_IN)   ┌───────────────────┐
│     (:Entity)     ├────────────────►│     (:Episode)    ├───────────────►│  (:WorkingMemory) │
│ (User / Wren self)│                 │ (Interaction Log) │                │  (Active Focus)   │
└─────────┬─────────┘                 └─────────┬─────────┘                └───────────────────┘
          │                                     │
          │ (HAS_CONCEPT)                       │ (CONSOLIDATED_TO)
          ▼                                     ▼
┌───────────────────────────────────────────────────────────┐
│                       (:Concept)                          │
│     Semantic Knowledge Graph (Objects, Facts, Rules)      │
└───────────────────────────────────────────────────────────┘
```

---

## 3. Key Relationships
- `(:Episode)-[:HAD_STATE]->(:AffectState)`
- `(:Episode)-[:CONSOLIDATED_TO]->(:Concept)`
- `(:Concept)-[:RELATED_TO {weight: float}]->(:Concept)`
- `(:Episode)-[:PRECEDED]->(:Episode)`

---

## 4. Neo4j Initialization Script (Cypher)

```cypher
// Uniqueness Constraints
CREATE CONSTRAINT unique_entity_id IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE;
CREATE CONSTRAINT unique_episode_id IF NOT EXISTS FOR (ep:Episode) REQUIRE ep.id IS UNIQUE;
CREATE CONSTRAINT unique_concept_name IF NOT EXISTS FOR (c:Concept) REQUIRE c.name IS UNIQUE;

// Core Entity Nodes Setup
MERGE (wren:Entity {id: 'wren_self', name: 'Wren', type: 'self'})
  ON CREATE SET wren.created_at = datetime();

MERGE (user:Entity {id: 'primary_user', name: 'User', type: 'user'})
  ON CREATE SET user.trust_level = 0.5, user.created_at = datetime();

// Vector Index for Semantic Concept Retrieval
CREATE VECTOR INDEX concept_embedding_index IF NOT EXISTS
FOR (c:Concept) ON (c.embedding)
OPTIONS {indexConfig: {
 `vector.dimensions`: 1536,
 `vector.similarity_function`: 'cosine'
}};
```