import os
import psycopg2
from dotenv import load_dotenv

load_dotenv()

NEON_DB_URI = os.environ.get("NEON_DB_URI") or os.environ.get("DATABASE_URL")

def setup_vector_table():
    conn = psycopg2.connect(NEON_DB_URI)
    conn.autocommit = True
    cur = conn.cursor()
    
    print("1. Enabling pgvector extension...")
    cur.execute("CREATE EXTENSION IF NOT EXISTS vector;")
    
    print("2. Re-creating document_embeddings table for vector(1536)...")
    cur.execute('DROP TABLE IF EXISTS "document_embeddings" CASCADE;')
    
    create_sql = """
    CREATE TABLE "document_embeddings" (
        "embedding_id" SERIAL PRIMARY KEY,
        "source_table" VARCHAR(100) NOT NULL,
        "record_id" INT NOT NULL,
        "parent_id" INT,
        "file_name" TEXT,
        "chunk_index" INT NOT NULL,
        "chunk_text" TEXT NOT NULL,
        "embedding" vector(1536) NOT NULL,
        "embedding_model" VARCHAR(100) NOT NULL,
        "embedding_dim" INT NOT NULL,
        "category" TEXT,
        "subject" TEXT,
        "sections" TEXT,
        "doc_title" TEXT,
        "law_title" TEXT,
        "doc_date" TIMESTAMP,
        "created_at" TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT uniq_source_record_chunk UNIQUE ("source_table", "record_id", "chunk_index")
    );
    """
    cur.execute(create_sql)
    
    print("3. Creating performance indexes...")
    cur.execute('CREATE INDEX idx_doc_emb_source ON "document_embeddings" ("source_table");')
    cur.execute('CREATE INDEX idx_doc_emb_source_rec ON "document_embeddings" ("source_table", "record_id");')
    cur.execute('CREATE INDEX idx_doc_emb_doc_title ON "document_embeddings" USING gin (to_tsvector(\'english\', COALESCE("doc_title", \'\')));')
    cur.execute('CREATE INDEX idx_doc_emb_chunk_text ON "document_embeddings" USING gin (to_tsvector(\'english\', "chunk_text"));')
    
    # HNSW Index for fast vector similarity search using cosine distance (<=>)
    print("4. Creating HNSW index for vector(1536)...")
    cur.execute('CREATE INDEX idx_doc_emb_vector_hnsw ON "document_embeddings" USING hnsw ("embedding" vector_cosine_ops);')
    
    print("pgvector setup completed successfully!")
    cur.close()
    conn.close()

if __name__ == '__main__':
    setup_vector_table()
