import { beforeEach, describe, expect, it, vi } from "vitest";
import { isRef } from "vue";
import type * as VueModule from "vue";

vi.mock("vue", async () => {
  const actual = await vi.importActual<typeof VueModule>("vue");
  return {
    ...actual,
    onMounted: () => {},
    onUnmounted: () => {},
  };
});

const {
  mockGetServerLog,
  mockGetIncrementalServerLog,
  mockShowMessage,
  mockCopyToClipboard,
  mockAskConfirm,
  mockSetScrollTop,
  mockLoggerWarn,
  mockUseVirtualScroll,
} = vi.hoisted(() => ({
  mockGetServerLog: vi.fn(async () => ({})),
  mockGetIncrementalServerLog: vi.fn(async () => ({})),
  mockShowMessage: vi.fn(),
  mockCopyToClipboard: vi.fn(async () => true),
  mockAskConfirm: vi.fn(async () => true),
  mockSetScrollTop: vi.fn(),
  mockLoggerWarn: vi.fn(),
  mockUseVirtualScroll: vi.fn(),
}));

vi.mock("@/api", () => ({
  systemApi: {
    getServerLog: (...args: unknown[]) => mockGetServerLog(...args),
    getIncrementalServerLog: (...args: unknown[]) =>
      mockGetIncrementalServerLog(...args),
  },
}));

vi.mock("@/utils", () => ({
  showMessage: (...args: unknown[]) => mockShowMessage(...args),
  copyToClipboard: mockCopyToClipboard,
}));
vi.mock("@/platform/feedback/feedbackBus", () => ({
  askConfirm: mockAskConfirm,
}));

vi.mock("@/utils/logger", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockLoggerWarn,
    error: vi.fn(),
  }),
}));

vi.mock("@/composables/useVirtualScroll", () => ({
  useVirtualScroll: (...args: unknown[]) => mockUseVirtualScroll(...args),
}));

vi.mock("@/composables/usePolling", () => ({
  usePolling: () => ({
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));

import { useServerLogViewer } from "@/features/server-log-viewer/useServerLogViewer";

describe("useServerLogViewer", () => {
  beforeEach(() => {
    mockGetServerLog.mockReset();
    mockGetIncrementalServerLog.mockReset();
    mockShowMessage.mockReset();
    mockCopyToClipboard.mockReset().mockResolvedValue(true);
    mockAskConfirm.mockReset().mockResolvedValue(true);
    mockSetScrollTop.mockReset();
    mockLoggerWarn.mockReset();
    mockUseVirtualScroll.mockReset();
    mockUseVirtualScroll.mockReturnValue({
      visibleItems: [],
      totalHeight: 0,
      offsetY: 0,
      onScroll: vi.fn(),
      setScrollTop: mockSetScrollTop,
    });
    vi.stubGlobal("confirm", vi.fn(() => true));
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: vi.fn(),
      },
    });
  });

  it("loads log content and computes line stats", async () => {
    mockGetServerLog.mockResolvedValueOnce({
      content: "line1\nline2\nline3",
      path: "/tmp/server.log",
    });

    const state = useServerLogViewer();
    await state.loadLog();

    expect(state.logPath.value).toBe("/tmp/server.log");
    expect(state.totalLines.value).toBe(3);
    expect(state.displayedLines.value).toHaveLength(3);
  });

  it("passes a reactive container height into the virtual scroller", () => {
    useServerLogViewer();

    const virtualScrollOptions = mockUseVirtualScroll.mock.calls[0]?.[1] as {
      containerHeight: unknown;
    };

    expect(isRef(virtualScrollOptions.containerHeight)).toBe(true);
  });

  it("supports filter/reverse/toggle/clear interactions", async () => {
    mockGetServerLog.mockResolvedValueOnce({
      content: "[INFO] boot\n[ERROR] failed",
      path: "p",
    });

    const state = useServerLogViewer();
    await state.loadLog();

    state.filterText.value = "ERROR";
    state.handleFilter();
    expect(mockSetScrollTop).toHaveBeenCalled();
    expect(state.filteredLines.value).toHaveLength(1);

    state.toggleReverse();
    expect(state.isReverse.value).toBe(true);

    state.toggleAutoScroll();
    expect(state.autoScroll.value).toBe(false);

    await state.copyLog();
    expect(mockCopyToClipboard).toHaveBeenCalledWith("[ERROR] failed");
    expect(mockShowMessage).toHaveBeenCalledWith("日志已复制到剪贴板", "success");

    await state.clearLog();
    expect(state.totalLines.value).toBe(0);
  });

  it("reports clipboard failure and keeps log contents when clearing is declined", async () => {
    mockGetServerLog.mockResolvedValueOnce({ content: "keep me", path: "synthetic.log" });
    const state = useServerLogViewer();
    await state.loadLog();
    mockCopyToClipboard.mockResolvedValueOnce(false);
    await state.copyLog();
    expect(mockCopyToClipboard).toHaveBeenCalledWith("keep me");
    expect(mockShowMessage).toHaveBeenCalledWith("复制失败，请手动选择文本复制", "error");
    mockAskConfirm.mockResolvedValueOnce(false);
    await state.clearLog();
    expect(state.totalLines.value).toBe(1);
    expect(state.displayedLines.value[0].content).toBe("keep me");
  });

  it("marks polling failures by logger warn when initial load already succeeded", async () => {
    mockGetServerLog.mockResolvedValueOnce({ content: "ok", path: "p" });
    mockGetIncrementalServerLog.mockRejectedValueOnce(new Error("network"));

    const state = useServerLogViewer();
    await state.loadLog();
    await state.loadLog();

    expect(mockLoggerWarn).toHaveBeenCalled();
  });

  it("exposes stable feature contract for server log viewer integration", () => {
    const state = useServerLogViewer();

    expect(Object.keys(state).sort()).toEqual(
      [
        "autoScroll",
        "clearLog",
        "copyLog",
        "displayedLines",
        "filterText",
        "filteredLines",
        "getLineClass",
        "handleFilter",
        "handleScroll",
        "highlightText",
        "isLoading",
        "isReverse",
        "loadLog",
        "logContainerRef",
        "logLimit",
        "logLines",
        "logPath",
        "offsetY",
        "scrollToBottom",
        "showScrollToBottom",
        "toggleAutoScroll",
        "toggleReverse",
        "totalHeight",
        "totalLines",
        "visibleLines",
      ].sort()
    );
  });
});
