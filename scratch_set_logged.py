import os
import psycopg2
from dotenv import load_dotenv

load_dotenv()

conn = psycopg2.connect(os.environ['NEON_DB_URI'])
conn.autocommit = True
cur = conn.cursor()

cur.execute("SELECT tablename FROM pg_tables WHERE schemaname = 'public';")
tables = [r[0] for r in cur.fetchall()]

for t in tables:
    try:
        cur.execute(f'ALTER TABLE "{t}" SET LOGGED;')
        print(f"Set {t} to LOGGED.")
    except Exception as e:
        print(f"Error setting {t} to LOGGED: {e}")

cur.close()
conn.close()
