import { describe, it, expect } from "vitest";
import { makeSparkBuffer } from "../media/ui/components/sparkline";

describe("makeSparkBuffer", () => {
  it("keeps at most N points, newest last", () => {
    const b = makeSparkBuffer(3);
    [1, 2, 3, 4].forEach((v) => b.push(v));
    expect(b.values()).toEqual([2, 3, 4]);
  });
  it("reset clears", () => {
    const b = makeSparkBuffer(3);
    b.push(1);
    b.push(2);
    b.reset();
    expect(b.values()).toEqual([]);
  });
  it("returns a copy (caller can't mutate internal state)", () => {
    const b = makeSparkBuffer(3);
    b.push(1);
    b.values().push(999);
    expect(b.values()).toEqual([1]);
  });
});
