import os
import pyodbc
from dotenv import load_dotenv

load_dotenv()

SQL_CONN_STR = os.environ["SQL_CONN_STR"]

_SOURCE_TABLES = [
    "Articles_data_2025",
    "caselaws_data_2025",
    "Circular_data_2025",
    "legislation_data_2025",
    "notifications_data_2025"
]

def main():
    cnx = pyodbc.connect(SQL_CONN_STR)
    cur = cnx.cursor()
    
    for table in _SOURCE_TABLES:
        print("="*60)
        print(f"TABLE: {table}")
        try:
            cur.execute(f"SELECT TOP 1 * FROM dbo.{table}")
            row = cur.fetchone()
            if not row:
                print("No records found.")
                continue
            
            cols = [c[0] for c in cur.description]
            row_dict = dict(zip(cols, row))
            
            # Print columns
            print("Columns:", list(row_dict.keys()))
            
            # Find content column
            content_col = None
            for col in ["Filetext", "Commentary_Details", "Procedure", "filehtml", "FileHtml", "RawText"]:
                if col in row_dict:
                    content_col = col
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
            
    cur.close()
    cnx.close()

if __name__ == "__main__":
    main()
