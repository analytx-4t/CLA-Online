export default function DataTable({ columns, rows, onRowClick }) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-line">
      <div className="overflow-x-auto">
        <table className="min-w-full table-fixed border-separate border-spacing-0 text-sm text-ink">
          <thead className="bg-surface-muted text-left text-[10px] uppercase tracking-[0.2em] text-muted">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.accessor}
                  style={column.width ? { width: column.width } : undefined}
                  className="sticky top-0 border-b border-line px-3 py-2.5 text-left"
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.id || index} onClick={() => onRowClick?.(row)} className={`h-11 border-b border-line bg-surface transition ${onRowClick ? 'cursor-pointer hover:bg-surface-muted' : ''}`}>
                {columns.map((column) => (
                  <td key={column.accessor} style={column.width ? { width: column.width } : undefined} className="px-3 py-2 align-top text-ink">
                    <div className="max-w-full overflow-hidden text-ellipsis whitespace-nowrap">
                      {column.render ? column.render(row) : row[column.accessor]}
                    </div>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
