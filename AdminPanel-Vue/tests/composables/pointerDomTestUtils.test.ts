import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMockHTMLElement,
  installPointerDomTestGlobals,
} from "./pointerDomTestUtils";

vi.mock("vue", async () => ({
  ...await vi.importActual<typeof import("vue")>("vue"),
  onBeforeUnmount: () => {},
}));
import { usePointerDragSession } from "@/composables/usePointerDragSession";

afterEach(() => { vi.unstubAllGlobals(); });

function pointer(overrides: Partial<PointerEvent> = {}): PointerEvent {
  return {
    pointerId: 1, pointerType: "mouse", button: 0,
    clientX: 10, clientY: 10,
    preventDefault: vi.fn(), stopPropagation: vi.fn(), ...overrides,
  } as unknown as PointerEvent;
}

describe("pointer DOM fixture and real drag session", () => {
  it("queues animation frames and respects cancellation and next-frame scheduling", () => {
    const dom = installPointerDomTestGlobals();
    const events: string[] = [];
    requestAnimationFrame(() => {
      events.push("first");
      requestAnimationFrame(() => events.push("next"));
    });
    const cancelled = requestAnimationFrame(() => events.push("cancelled"));
    cancelAnimationFrame(cancelled);
    expect(events).toEqual([]);
    dom.flushAnimationFrame();
    expect(events).toEqual(["first"]);
    expect(dom.pendingFrames()).toBe(1);
    dom.flushAnimationFrame();
    expect(events).toEqual(["first", "next"]);
    expect(dom.pendingFrames()).toBe(0);
  });

  it("uses explicit geometry, selectors, event removal and pointer capture", () => {
    const element = createMockHTMLElement({
      dataset: { item: "one" }, rect: { left: 5, top: 12, width: 40, height: 20 },
    });
    const dom = installPointerDomTestGlobals(() => element);
    element.setClosest("[data-item]", element);
    element.setQuerySelectorAll("[data-item]", [element]);
    expect(element instanceof HTMLElement).toBe(true);
    expect(document.elementFromPoint(8, 15)).toBe(element);
    expect(element.closest("[data-item]")).toBe(element);
    expect(element.closest(".missing")).toBeNull();
    expect(element.querySelectorAll("[data-item]")).toEqual([element]);
    expect(element.getBoundingClientRect()).toMatchObject({ top: 12, bottom: 32, left: 5, right: 45 });
    element.setPointerCapture(7);
    expect(element.hasPointerCapture(7)).toBe(true);
    element.releasePointerCapture(7);
    expect(element.hasPointerCapture(7)).toBe(false);
    const listener = vi.fn();
    dom.windowMock.addEventListener("pointermove", listener);
    dom.windowMock.dispatch("pointermove", { pointerId: 7 });
    dom.windowMock.removeEventListener("pointermove", listener);
    dom.windowMock.dispatch("pointermove", { pointerId: 7 });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("runs multiple frames in the real session and commits only after activation", () => {
    const dom = installPointerDomTestGlobals();
    const capture = createMockHTMLElement();
    const onFrame = vi.fn(), onCommit = vi.fn();
    const session = usePointerDragSession({
      createGhost: (item: string) => ({ label: item }), onFrame, onCommit,
    });
    expect(session.startPointerDrag({
      item: "one", event: pointer(),
      itemElement: capture as unknown as HTMLElement,
      captureElement: capture as unknown as HTMLElement,
    })).toBe(true);
    dom.windowMock.dispatch("pointermove", pointer({ pointerId: 2, clientY: 50 }));
    expect(dom.pendingFrames()).toBe(0);
    dom.windowMock.dispatch("pointermove", pointer({ clientY: 14 }));
    dom.flushAnimationFrame();
    expect(session.pointerState.value?.dragging).toBe(false);
    expect(onFrame).not.toHaveBeenCalled();
    dom.windowMock.dispatch("pointermove", pointer({ clientY: 30 }));
    dom.flushAnimationFrame();
    expect(session.pointerState.value?.dragging).toBe(true);
    dom.windowMock.dispatch("pointermove", pointer({ clientY: 40 }));
    dom.flushAnimationFrame();
    expect(onFrame).toHaveBeenCalledTimes(2);
    expect(session.pointerState.value?.rafId).toBeNull();
    dom.windowMock.dispatch("pointerup", pointer());
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(session.pointerState.value).toBeNull();
    expect(capture.hasPointerCapture(1)).toBe(false);
    expect(dom.windowMock.listenerCount("pointermove")).toBe(0);
    expect(dom.documentMock.listenerCount("visibilitychange")).toBe(0);
  });

  it("cancels a queued frame and never commits a cancelled drag", () => {
    const dom = installPointerDomTestGlobals();
    const capture = createMockHTMLElement();
    const onFrame = vi.fn(), onCommit = vi.fn(), onCancel = vi.fn();
    const session = usePointerDragSession({
      createGhost: (item: string) => ({ label: item }), onFrame, onCommit, onCancel,
    });
    session.startPointerDrag({
      item: "one", event: pointer(),
      itemElement: capture as unknown as HTMLElement,
      captureElement: capture as unknown as HTMLElement,
    });
    dom.windowMock.dispatch("pointermove", pointer({ clientY: 35 }));
    expect(dom.pendingFrames()).toBe(1);
    dom.windowMock.dispatch("pointercancel", pointer());
    dom.flushAnimationFrame();
    expect(onFrame).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(session.pointerState.value).toBeNull();
    expect(capture.hasPointerCapture(1)).toBe(false);
    expect(dom.pendingFrames()).toBe(0);
  });
});