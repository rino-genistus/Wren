"""Connection and schema-init helpers for Wren's memory stores.

Neo4j Aura holds the graph (entities, episodes, concepts, relationships).
Pinecone holds :Concept embeddings, generated locally via Ollama's
mxbai-embed-large (1024-d) — see memory-instructions/04_neo4j_graph_schema.md.

Infrastructure only: nothing here is wired into the app yet.
"""

import os

import ollama
from dotenv import load_dotenv
from neo4j import GraphDatabase
from pinecone import Pinecone, ServerlessSpec

load_dotenv()

EMBED_MODEL = "mxbai-embed-large"
EMBED_DIMENSION = 1024
PINECONE_CLOUD = "aws"
PINECONE_REGION = "us-east-1"

NEO4J_SCHEMA_CONSTRAINTS = """
CREATE CONSTRAINT unique_entity_id IF NOT EXISTS FOR (e:Entity) REQUIRE e.id IS UNIQUE;
CREATE CONSTRAINT unique_episode_id IF NOT EXISTS FOR (ep:Episode) REQUIRE ep.id IS UNIQUE;
CREATE CONSTRAINT unique_concept_name IF NOT EXISTS FOR (c:Concept) REQUIRE c.name IS UNIQUE;
""".strip()

NEO4J_SEED_ENTITIES = """
MERGE (wren:Entity {id: 'wren_self', name: 'Wren', type: 'self'})
  ON CREATE SET wren.created_at = datetime();

MERGE (user:Entity {id: 'primary_user', name: 'User', type: 'user'})
  ON CREATE SET user.trust_level = 0.5, user.created_at = datetime();
""".strip()


def get_neo4j_driver():
    uri = os.getenv("NEO4J_URI")
    user = os.getenv("NEO4J_USER")
    password = os.getenv("NEO4J_PASSWORD")
    return GraphDatabase.driver(uri, auth=(user, password))


def init_neo4j_schema(driver):
    """Create uniqueness constraints and seed the fixed :Entity nodes."""
    for statement in NEO4J_SCHEMA_CONSTRAINTS.split(";"):
        statement = statement.strip()
        if statement:
            driver.execute_query(statement)

    for statement in NEO4J_SEED_ENTITIES.split(";"):
        statement = statement.strip()
        if statement:
            driver.execute_query(statement)


def get_pinecone_index():
    """Connect to the Pinecone index, creating it if it doesn't exist yet."""
    pc = Pinecone(api_key=os.getenv("PINECONE_API_KEY"))
    index_name = os.getenv("PINECONE_INDEX_NAME")

    if not pc.has_index(index_name):
        pc.create_index(
            name=index_name,
            dimension=EMBED_DIMENSION,
            metric="cosine",
            spec=ServerlessSpec(cloud=PINECONE_CLOUD, region=PINECONE_REGION),
        )

    return pc.Index(index_name)


def embed(text: str) -> list[float]:
    """Embed text locally via Ollama's mxbai-embed-large."""
    response = ollama.embed(model=EMBED_MODEL, input=text)
    return list(response.embeddings[0])


def main():
    driver = get_neo4j_driver()
    driver.verify_connectivity()
    init_neo4j_schema(driver)
    entity_count = driver.execute_query(
        "MATCH (e:Entity) WHERE e.id IN ['wren_self', 'primary_user'] RETURN count(e) AS n"
    ).records[0]["n"]
    print(f"neo4j: connected, schema initialized, {entity_count}/2 seed entities present")
    driver.close()

    index = get_pinecone_index()
    stats = index.describe_index_stats()
    print(f"pinecone: connected to '{os.getenv('PINECONE_INDEX_NAME')}' (dimension={stats.dimension})")

    vector = embed("Wren memory infrastructure smoke test")
    print(f"ollama: embedded smoke-test text via {EMBED_MODEL} -> {len(vector)}-d vector")


if __name__ == "__main__":
    main()
