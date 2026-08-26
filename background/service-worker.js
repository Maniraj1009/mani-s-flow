chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
    /* ignore if API unavailable */
  });
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {
    /* ignore */
  });
});

/* Enforce custom download filenames and prevent Chrome CDN hash overrides */
if (chrome.downloads && chrome.downloads.onDeterminingFilename) {
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    if (item.byExtensionId === chrome.runtime.id && item.filename) {
      suggest({ filename: item.filename, conflictAction: "uniquify" });
      return true;
    }
  });
}

/* ── MAIN world React fiber submit ───────────────────────────────────
 * chrome.scripting.executeScript with world:"MAIN" bypasses the page's
 * CSP and runs in the same JS context as React / Slate.
 *
 * The content script marks the target button with a data attribute,
 * then asks us to find and invoke the real submission handler from
 * the React fiber tree.
 * ---------------------------------------------------------------- */

/**
 * Injected into the page's MAIN world via chrome.scripting.executeScript.
 * Must be fully self-contained — no closures over service-worker scope.
 */
function reactFiberSubmit(token, markerAttr, mode) {
  var el = document.querySelector("[" + markerAttr + '="' + token + '"]');
  if (!el) return { ok: false, reason: "element not found in MAIN world" };

  // Find React fiber key
  var fiberKey = Object.keys(el).find(function (k) {
    return (
      k.startsWith("__reactFiber$") ||
      k.startsWith("__reactInternalInstance$")
    );
  });
  if (!fiberKey) return { ok: false, reason: "no React fiber on element" };

  // Walk the fiber tree and collect the nearest handler of each kind
  var handlers = {}; // name -> { fn, depth }
  var HANDLER_NAMES = ["onClick", "onPointerDown", "onMouseDown", "onPointerUp", "onMouseUp"];

  var fiber = el[fiberKey];
  var depth = 0;
  while (fiber && depth < 30) {
    var props = fiber.memoizedProps;
    if (props) {
      for (var h = 0; h < HANDLER_NAMES.length; h++) {
        var name = HANDLER_NAMES[h];
        if (!handlers[name] && typeof props[name] === "function") {
          handlers[name] = { fn: props[name], depth: depth };
        }
      }
    }
    fiber = fiber.return;
    depth++;
  }

  // Also check __reactProps$ for direct handlers
  var propsKey = Object.keys(el).find(function (k) {
    return k.startsWith("__reactProps$");
  });
  if (propsKey) {
    var directProps = el[propsKey];
    for (var d = 0; d < HANDLER_NAMES.length; d++) {
      var dn = HANDLER_NAMES[d];
      if (!handlers[dn] && typeof directProps[dn] === "function") {
        handlers[dn] = { fn: directProps[dn], depth: -1 };
      }
    }
  }

  // Skip onSubmit() — calling it with a non-Event arg makes Flow run
  // empty-prompt validation. onClick on the Create button submits correctly.

  var rect = el.getBoundingClientRect();
  function fakeEvent(type) {
    return {
      type: type,
      target: el,
      currentTarget: el,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
      button: 0,
      buttons: type === "pointerdown" || type === "mousedown" ? 1 : 0,
      pointerId: 1,
      pointerType: "mouse",
      isTrusted: true,
      detail: 1,
      preventDefault: function () {},
      stopPropagation: function () {},
      isPropagationStopped: function () { return false; },
      isDefaultPrevented: function () { return false; },
      nativeEvent: { type: type, isTrusted: true },
    };
  }

  // mode "press": popover/dropdown triggers open on pointer-down, not click —
  // fire the whole press sequence, each handler that exists.
  if (mode === "press") {
    var seq = [
      ["onPointerDown", "pointerdown"],
      ["onMouseDown",   "mousedown"],
      ["onPointerUp",   "pointerup"],
      ["onMouseUp",     "mouseup"],
      ["onClick",       "click"],
    ];
    var invoked = [];
    for (var s = 0; s < seq.length; s++) {
      var entry = handlers[seq[s][0]];
      if (entry) {
        try { entry.fn(fakeEvent(seq[s][1])); invoked.push(seq[s][0]); } catch (e) { /* keep going */ }
      }
    }
    if (invoked.length) return { ok: true, method: invoked.join("+"), depth: 0 };
    return { ok: false, reason: "no press handlers found in fiber tree" };
  }

  // default mode: onClick only (proven path for the Create button)
  var click = handlers.onClick;
  if (click) {
    try {
      click.fn(fakeEvent("click"));
      return { ok: true, method: "onClick", depth: click.depth };
    } catch (e) {
      return { ok: false, reason: "onClick threw: " + e.message };
    }
  }

  return { ok: false, reason: "onClick not found in fiber tree" };
}

// Simple main-world click for toggle buttons (no fiber needed)
function mainWorldAgentClick() {
  var btn = Array.from(document.querySelectorAll("button[aria-pressed]"))
    .find(function(b) { return /agent/i.test(b.textContent); });
  if (!btn) return { ok: false, reason: "Agent button not found" };
  if (btn.getAttribute("aria-pressed") !== "true") return { ok: true, skipped: true };
  btn.click();
  return { ok: true };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "MAIN_WORLD_AGENT_CLICK") {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ ok: false, reason: "no tab id" }); return; }
    chrome.scripting
      .executeScript({ target: { tabId }, world: "MAIN", func: mainWorldAgentClick })
      .then(results => sendResponse(results?.[0]?.result || { ok: false, reason: "no result" }))
      .catch(e => sendResponse({ ok: false, reason: String(e?.message || e) }));
    return true;
  }

  if (msg?.type !== "REACT_FIBER_CLICK") return;

  const tabId = sender.tab?.id;
  if (!tabId) {
    sendResponse({ ok: false, reason: "no tab id" });
    return;
  }

  chrome.scripting
    .executeScript({
      target: { tabId },
      world: "MAIN",
      func: reactFiberSubmit,
      args: [msg.token, msg.markerAttr, msg.mode || "click"],
    })
    .then((results) => {
      const val = results?.[0]?.result;
      sendResponse(val || { ok: false, reason: "no result from injection" });
    })
    .catch((e) => {
      sendResponse({ ok: false, reason: String(e?.message || e) });
    });

  return true; // async sendResponse
});
