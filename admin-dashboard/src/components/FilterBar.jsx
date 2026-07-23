export default function FilterBar({ children }) {
  return (
    <div className="card flex flex-col gap-3 p-3 sm:flex-row sm:items-center sm:justify-between">
      {children}
    </div>
  );
}
