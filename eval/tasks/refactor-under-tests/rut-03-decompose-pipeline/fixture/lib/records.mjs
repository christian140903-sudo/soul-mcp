export function processRecord(line) {
  // parse
  const parts = line.split(";");
  if (parts.length !== 3) {
    throw new Error("malformed record: expected 3 fields");
  }
  const record = {
    name: parts[0].trim(),
    qty: Number(parts[1]),
    unit: parts[2].trim()
  };
  // validate
  if (record.name === "") {
    throw new Error("invalid record: empty name");
  }
  if (!Number.isInteger(record.qty) || record.qty < 0) {
    throw new Error("invalid record: qty must be a non-negative integer");
  }
  if (record.unit === "") {
    throw new Error("invalid record: empty unit");
  }
  // format
  return record.name + " x" + String(record.qty) + " [" + record.unit + "]";
}
