export default function DataTable({ columns, rows }) {
  return (
    <div className="overflow-hidden rounded-[10px] border border-slate-800/80 bg-[#0B1119]/90 shadow-sm">
      <div className="overflow-x-auto">
        <table className="min-w-full table-fixed border-separate border-spacing-0 text-sm text-slate-300">
          <thead className="bg-[#111827]/95 text-left text-[10px] uppercase tracking-[0.24em] text-slate-500">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.accessor}
                  style={column.width ? { width: column.width } : undefined}
                  className="sticky top-0 border-b border-slate-800/80 px-2 py-2 backdrop-blur-xl text-left"
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.id || index} className="h-12 border-b border-slate-800/80 bg-[#0B1119] transition hover:bg-slate-900/80">
                {columns.map((column) => (
                  <td key={column.accessor} style={column.width ? { width: column.width } : undefined} className="px-2 py-2 align-top">
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
