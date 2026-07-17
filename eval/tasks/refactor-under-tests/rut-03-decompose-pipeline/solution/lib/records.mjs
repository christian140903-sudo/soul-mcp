export function parseRecord(line) {
  const parts = line.split(";");
  if (parts.length !== 3) {
    throw new Error("malformed record: expected 3 fields");
  }
  return {
    name: parts[0].trim(),
    qty: Number(parts[1]),
    unit: parts[2].trim()
  };
}

export function validateRecord(record) {
  if (record.name === "") {
    throw new Error("invalid record: empty name");
  }
  if (!Number.isInteger(record.qty) || record.qty < 0) {
    throw new Error("invalid record: qty must be a non-negative integer");
  }
  if (record.unit === "") {
    throw new Error("invalid record: empty unit");
  }
  return record;
}

export function formatRecord(record) {
  return record.name + " x" + String(record.qty) + " [" + record.unit + "]";
}

export function processRecord(line) {
  return formatRecord(validateRecord(parseRecord(line)));
}
