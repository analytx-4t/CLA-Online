import os, sys, re, time
import psycopg2
from psycopg2.extras import execute_values

DB_URI = "postgresql://neondb_owner:npg_V2epn6DfNqmJ@ep-wandering-fog-ayy57526-pooler.c-5.us-east-2.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
FOLDER = r"C:\Users\hp\Documents\SQL Server Management Studio\New folder"

filename = "dbo.notifications_data.Table.sql"
target_table = "notifications_data_2025"
cols_spec = [
    ("ID", "INTEGER"),
    ("Notification_ID", "INTEGER"),
    ("FileName", "TEXT"),
    ("Filetext", "TEXT"),
    ("FileHTML", "TEXT"),
    ("srn", "INTEGER"),
]

def parse_values_content_fast(val_str):
    val_str = re.sub(r"'\s*\+\s*N'", "", val_str)
    val_str = re.sub(r"'\s*\+\s*'", "", val_str)
    
    vals = []
    i = 0
    n = len(val_str)
    
    while i < n:
        while i < n and val_str[i] in ' \t\r\n,':
            i += 1
        if i >= n:
            break
            
        if val_str[i] in ("'", "N") and (val_str[i] == "'" or (i + 1 < n and val_str[i+1] == "'")):
            if val_str[i] == 'N':
                i += 1
            i += 1
            start = i
            while i < n:
                quote_pos = val_str.find("'", i)
                if quote_pos == -1:
                    s = val_str[start:].replace("''", "'")
                    vals.append(s)
                    i = n
                    break
                if quote_pos + 1 < n and val_str[quote_pos + 1] == "'":
                    i = quote_pos + 2
                    continue
                else:
                    s = val_str[start:quote_pos].replace("''", "'")
                    vals.append(s)
                    i = quote_pos + 1
                    break
            
        elif val_str[i:i+5].upper() == 'CAST(':
            end_cast = val_str.find(')', i)
            if end_cast != -1:
                i = end_cast + 1
                vals.append(None)
            else:
                vals.append(None)
                i += 5
                
        elif val_str[i:i+4].upper() == 'NULL' and (i+4 == n or val_str[i+4] in ' \t\r\n,'):
            vals.append(None)
            i += 4
            
        else:
            j = i
            while j < n and val_str[j] not in ' \t\r\n,':
                j += 1
            token = val_str[i:j].strip()
            i = j
            if token:
                if token.isdigit() or (token.startswith('-') and token[1:].isdigit()):
                    vals.append(int(token))
                else:
                    try:
                        vals.append(float(token))
                    except ValueError:
                        vals.append(token)
                        
    return vals

def clean_statement_quote_aware(stmt):
    i = 0
    n = len(stmt)
    cut_idx = None
    
    while i < n:
        if stmt[i] in ("'", "N") and (stmt[i] == "'" or (i + 1 < n and stmt[i+1] == "'")):
            if stmt[i] == 'N':
                i += 1
            i += 1
            start = i
            while i < n:
                quote_pos = stmt.find("'", i)
                if quote_pos == -1:
                    i = n
                    break
                if quote_pos + 1 < n and stmt[quote_pos + 1] == "'":
                    i = quote_pos + 2
                    continue
                else:
                    i = quote_pos + 1
                    break
        else:
            if stmt[i] == '\n':
                rest = stmt[i+1:].lstrip()
                if rest.upper().startswith("GO") or rest.upper().startswith("SET IDENTITY_INSERT") or rest.upper().startswith("ALTER TABLE"):
                    cut_idx = i
                    break
            i += 1
            
    if cut_idx is not None:
        stmt = stmt[:cut_idx]
    return stmt.strip()

def run_migration():
    conn = psycopg2.connect(DB_URI)
    conn.autocommit = True
    cur = conn.cursor()
    
    t0 = time.time()
    print(f"\n[MIGRATING TABLE] {target_table}...")
    
    cur.execute(f'DROP TABLE IF EXISTS "{target_table}" CASCADE;')
    col_defs = [f'  "{cname}" {ctype}' for cname, ctype in cols_spec]
    create_sql = f'CREATE TABLE "{target_table}" (\n' + ',\n'.join(col_defs) + '\n);'
    cur.execute(create_sql)
    print(f"  -> Dropped & Recreated table '{target_table}'.")
    
    filepath = os.path.join(FOLDER, filename)
    total_parsed = 0
    batch = []
    batch_size = 200
    first_cols = None
    
    with open(filepath, 'r', encoding='utf-16', errors='replace') as f:
        buffer = []
        for line in f:
            if line.startswith("INSERT "):
                if buffer:
                    stmt = clean_statement_quote_aware(''.join(buffer))
                    m_cols = re.search(r"INSERT\s+\[dbo\]\.\[[^\]]+\]\s*\(([^)]+)\)\s*VALUES\s*\(", stmt, re.IGNORECASE)
                    if m_cols:
                        cols = [c.strip(" []") for c in m_cols.group(1).split(",")]
                        if not first_cols:
                            first_cols = cols
                        val_start = m_cols.end()
                        r_idx = stmt.rfind(')')
                        val_str = stmt[val_start:r_idx]
                        vals = parse_values_content_fast(val_str)
                        batch.append(vals)
                        total_parsed += 1
                        
                        if len(batch) >= batch_size:
                            col_names_quoted = ', '.join([f'"{c}"' for c in first_cols])
                            insert_query = f'INSERT INTO "{target_table}" ({col_names_quoted}) VALUES %s'
                            execute_values(cur, insert_query, batch, page_size=batch_size)
                            batch = []
                    buffer = []
            if buffer or line.startswith("INSERT "):
                buffer.append(line)
                
        if buffer:
            stmt = clean_statement_quote_aware(''.join(buffer))
            m_cols = re.search(r"INSERT\s+\[dbo\]\.\[[^\]]+\]\s*\(([^)]+)\)\s*VALUES\s*\(", stmt, re.IGNORECASE)
            if m_cols:
                cols = [c.strip(" []") for c in m_cols.group(1).split(",")]
                if not first_cols:
                    first_cols = cols
                val_start = m_cols.end()
                r_idx = stmt.rfind(')')
                val_str = stmt[val_start:r_idx]
                vals = parse_values_content_fast(val_str)
                batch.append(vals)
                total_parsed += 1

    if batch:
        col_names_quoted = ', '.join([f'"{c}"' for c in first_cols])
        insert_query = f'INSERT INTO "{target_table}" ({col_names_quoted}) VALUES %s'
        execute_values(cur, insert_query, batch, page_size=batch_size)
        batch = []
        
    cur.execute(f'SELECT COUNT(*) FROM "{target_table}"')
    db_count = cur.fetchone()[0]
    t1 = time.time()
    
    status = "SUCCESS" if db_count == total_parsed else "COUNT MISMATCH!"
    print(f"  -> Total Parsed: {total_parsed:6d} | Postgres Rows: {db_count:6d} | Status: {status} | Elapsed: {t1-t0:.2f}s")
    
    cur.close()
    conn.close()

if __name__ == '__main__':
    run_migration()
