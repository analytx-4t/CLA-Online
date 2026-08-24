import os
import psycopg2
from dotenv import load_dotenv

load_dotenv()

conn = psycopg2.connect(os.environ['NEON_DB_URI'])
cur = conn.cursor()

cur.execute("SELECT tablename FROM pg_tables WHERE schemaname = 'public';")
tables = [r[0] for r in cur.fetchall()]
print("All Tables in pg_tables:", sorted(tables))

for t in sorted(tables):
    try:
        cur.execute(f'SELECT COUNT(*) FROM "{t}"')
        cnt = cur.fetchone()[0]
        print(f"Table: {t} -> {cnt} rows")
    except Exception as e:
        print(f"Table: {t} -> ERROR: {e}")
        conn.rollback()

cur.close()
conn.close()
