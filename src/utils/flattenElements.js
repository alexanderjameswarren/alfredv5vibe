export const uid = () =>
  Date.now().toString(36) + Math.random().toString(36).substr(2);

// Flatten elements that reference other items (via itemId) into a single array with indent levels.
// itemsMap: object keyed by item id -> item, or a lookup function
export async function flattenElements(elements, getItem, depth = 0, visited = new Set()) {
  if (depth >= 3) return elements.map((el) => ({ ...el, indent: depth }));
  const result = [];
  for (const el of elements) {
    const itemId = el.itemId || el.item_id;
    if (itemId && !visited.has(itemId)) {
      const childItem = typeof getItem === "function" ? await getItem(itemId) : null;
      if (childItem && childItem.elements && childItem.elements.length > 0) {
        // Add a header for the referenced item
        result.push({ ...el, displayType: "header", indent: depth });
        visited.add(itemId);
        const childFlattened = await flattenElements(
          childItem.elements, getItem, depth + 1, visited
        );
        result.push(...childFlattened);
      } else {
        // Deleted or missing child — show placeholder
        result.push({ ...el, indent: depth, missing: !childItem });
      }
    } else if (itemId && visited.has(itemId)) {
      // Circular reference detected — skip
      result.push({ ...el, indent: depth, circular: true });
    } else {
      result.push({ ...el, indent: depth });
    }
  }
  return result;
}

// Test suite for flattenElements — run via: window.testFlatten()
window.testFlatten = async function () {
  let passed = 0;
  let failed = 0;

  function assert(name, condition) {
    if (condition) { console.log(`  ✅ ${name}`); passed++; }
    else { console.error(`  ❌ ${name}`); failed++; }
  }

  console.log("=== flattenElements tests ===");

  // Test 1: Simple reference (depth 1)
  const items1 = {
    childA: { elements: [{ name: "Child step 1", displayType: "step" }, { name: "Child step 2", displayType: "step" }] },
  };
  const r1 = await flattenElements(
    [{ name: "Header", displayType: "header" }, { name: "Ref", displayType: "bullet", itemId: "childA" }],
    (id) => items1[id]
  );
  assert("1. Simple ref: correct count", r1.length === 4);
  assert("1. Simple ref: header at indent 0", r1[0].indent === 0);
  assert("1. Simple ref: child steps at indent 1", r1[2].indent === 1 && r1[3].indent === 1);

  // Test 2: Nested reference (depth 2)
  const items2 = {
    b: { elements: [{ name: "B step", displayType: "step", itemId: "c" }] },
    c: { elements: [{ name: "C step", displayType: "step" }] },
  };
  const r2 = await flattenElements(
    [{ name: "A ref B", displayType: "bullet", itemId: "b" }],
    (id) => items2[id]
  );
  assert("2. Nested ref: has depth 2 element", r2.some((e) => e.indent === 2));

  // Test 3: Max depth (stops at depth 3)
  const items3 = {
    d1: { elements: [{ name: "d1", displayType: "step", itemId: "d2" }] },
    d2: { elements: [{ name: "d2", displayType: "step", itemId: "d3" }] },
    d3: { elements: [{ name: "d3", displayType: "step", itemId: "d4" }] },
    d4: { elements: [{ name: "d4 deep", displayType: "step" }] },
  };
  const r3 = await flattenElements(
    [{ name: "top", displayType: "step", itemId: "d1" }],
    (id) => items3[id]
  );
  assert("3. Max depth: no element beyond indent 3", r3.every((e) => e.indent <= 3));

  // Test 4: Circular reference
  const items4 = {
    loopA: { elements: [{ name: "A", displayType: "step", itemId: "loopB" }] },
    loopB: { elements: [{ name: "B", displayType: "step", itemId: "loopA" }] },
  };
  const r4 = await flattenElements(
    [{ name: "start", displayType: "step", itemId: "loopA" }],
    (id) => items4[id]
  );
  assert("4. Circular ref: has circular flag", r4.some((e) => e.circular === true));
  assert("4. Circular ref: terminates", r4.length < 20);

  // Test 5: Deleted child (returns null)
  const r5 = await flattenElements(
    [{ name: "Ref deleted", displayType: "step", itemId: "gone" }],
    () => null
  );
  assert("5. Deleted child: marks missing", r5[0].missing === true);
  assert("5. Deleted child: still in result", r5.length === 1);

  // Test 6: Missing child (returns undefined)
  const r6 = await flattenElements(
    [{ name: "Ref missing", displayType: "step", itemId: "nope" }],
    () => undefined
  );
  assert("6. Missing child: marks missing", r6[0].missing === true);

  // Test 7: Multiple references
  const items7 = {
    m1: { elements: [{ name: "M1 step", displayType: "step" }] },
    m2: { elements: [{ name: "M2 step", displayType: "step" }] },
  };
  const r7 = await flattenElements(
    [
      { name: "Ref M1", displayType: "bullet", itemId: "m1" },
      { name: "Ref M2", displayType: "bullet", itemId: "m2" },
    ],
    (id) => items7[id]
  );
  assert("7. Multiple refs: both flattened", r7.length === 4);
  assert("7. Multiple refs: M1 step present", r7.some((e) => e.name === "M1 step"));
  assert("7. Multiple refs: M2 step present", r7.some((e) => e.name === "M2 step"));

  console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
  return { passed, failed };
};
