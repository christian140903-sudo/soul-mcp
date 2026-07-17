export function makeReport(title, rows) {
  var lines = [];
  var i;
  for (i = 0; i < rows.length; i++) {
    var row = rows[i];
    lines.push(row.name + ": " + row.value);
  }
  return title + "\n" + lines.join("\n");
}

export function totalOf() {
  var total = 0;
  for (var j = 0; j < arguments.length; j++) {
    total = total + arguments[j];
  }
  return total;
}
