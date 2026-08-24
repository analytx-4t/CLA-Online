import os
import psycopg2
from psycopg2.extras import RealDictCursor
from dotenv import load_dotenv

load_dotenv()

NEON_DB_URI = os.environ.get("NEON_DB_URI") or os.environ.get("DATABASE_URL")

_SOURCE_TABLES = [
    "articles_data_2025",
    "caselaws_data_2025",
    "circular_data_2025",
    "legislation_data_2025",
    "notifications_data_2025"
]

def main():
    conn = psycopg2.connect(NEON_DB_URI)
    cur = conn.cursor(cursor_factory=RealDictCursor)
    
    for table in _SOURCE_TABLES:
        print("="*60)
        print(f"TABLE: {table}")
        try:
            cur.execute(f'SELECT * FROM "{table}" LIMIT 1;')
            row_dict = cur.fetchone()
            if not row_dict:
                print("No records found.")
                continue
            
            # Print columns
            print("Columns:", list(row_dict.keys()))
            
            # Find content column
            content_col = None
            for col in ["filetext", "commentary_details", "procedure", "filehtml", "rawtext"]:
                for key in row_dict.keys():
                    if key.lower() == col:
                        content_col = key
                        break
                if content_col:
                    break
            
            if content_col:
                content = row_dict[content_col]
                print(f"Content Column: {content_col}")
                print(f"Content Length: {len(str(content)) if content else 0}")
                if content:
                    print("Content Preview (first 500 chars):")
                    print(str(content)[:500])
            else:
                print("No known content column found.")
        except Exception as e:
            print(f"Error querying {table}: {e}")
            conn.rollback()
            
    cur.close()
    conn.close()

if __name__ == "__main__":
    main()
