export class Stack {
  constructor(capacity = Infinity) {
    this.capacity = capacity;
    this.items = [];
  }

  get size() {
    return this.items.length;
  }

  push(item) {
    if (this.items.length >= this.capacity) {
      throw new Error("stack is full");
    }
    this.items.push(item);
    return this.size;
  }

  pop() {
    if (this.items.length === 0) {
      throw new Error("stack is empty");
    }
    return this.items.pop();
  }

  peek() {
    if (this.items.length === 0) {
      throw new Error("stack is empty");
    }
    return this.items[this.items.length - 1];
  }

  clear() {
    this.items = [];
  }
}
