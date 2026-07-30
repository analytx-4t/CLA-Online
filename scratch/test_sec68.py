import pyodbc, os
from dotenv import load_dotenv
load_dotenv('backend/.env')

cnx = pyodbc.connect(os.environ['SQL_CONN_STR'])
cur = cnx.cursor()
sql = """
    SELECT TOP 5 ChunkText 
    FROM dbo.DocumentEmbeddings 
    WHERE SourceTable='Legislation' 
      AND (ChunkText LIKE '%Section 68%' OR ChunkText LIKE '%Section 68(%' OR ChunkText LIKE '%buy-back%' OR ChunkText LIKE '%buy back%')
"""
cur.execute(sql)
rows = cur.fetchall()
print(f"Found {len(rows)} rows for Section 68 / Buy-back")
for i, r in enumerate(rows):
    print(f"\n--- MATCH #{i+1} ---")
    print(r[0][:250])
