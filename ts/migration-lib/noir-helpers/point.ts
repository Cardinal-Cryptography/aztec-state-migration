import type { Point } from "@aztec/foundation/curves/grumpkin";

export function pointToNoir(point: Point) {
  return {
    x: point.x,
    y: point.y,
    is_infinite: point.isInfinite
  };
}
