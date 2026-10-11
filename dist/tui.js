// @bun
// tui.ts
import { Plugin } from "@opencode/plugin/tui";

// src/rpc.ts
import { Rpc } from "@opencode/plugin/rpc";
var reply = {
  type: "object",
  properties: { text: { type: "string" } },
  required: ["text"],
  additionalProperties: false
};
var Advisor = Rpc.define({
  id: "advisor",
  methods: {
    features: {
      input: { type: "object", additionalProperties: false },
      output: {
        type: "object",
        properties: { goal: { type: "boolean" } },
        required: ["goal"],
        additionalProperties: false
      }
    },
    advisor: {
      input: { type: "object", properties: { args: { type: "string" } }, required: ["args"], additionalProperties: false },
      output: reply
    },
    goalStatus: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" } },
        required: ["sessionID"],
        additionalProperties: false
      },
      output: {
        type: "object",
        properties: { goal: { type: ["object", "null"] } },
        required: ["goal"],
        additionalProperties: false
      }
    },
    goal: {
      input: {
        type: "object",
        properties: { sessionID: { type: "string" }, args: { type: "string" } },
        required: ["sessionID", "args"],
        additionalProperties: false
      },
      output: reply
    }
  },
  events: {
    notice: {
      schema: {
        type: "object",
        properties: { sessionID: { type: "string" }, text: { type: "string" } },
        required: ["sessionID", "text"],
        additionalProperties: false
      }
    }
  }
});

// src/sidebar.tsx
import { effect as _$effect } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { createComponent as _$createComponent } from "@opentui/solid";
import { TextAttributes } from "@opentui/core";
import { createSignal, onCleanup, Show } from "solid-js";
var POLL_MS = 5000;
function shorten(text, length) {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > length ? `${line.slice(0, length - 1)}\u2026` : line;
}
function GoalSection(props) {
  const theme = props.context.theme;
  const [goal, setGoal] = createSignal(null);
  const refresh = () => props.status(props.sessionID).then((value) => setGoal(value && (value.status === "running" || value.status === "paused") ? value : null)).catch(() => setGoal(null));
  refresh();
  const timer = setInterval(() => void refresh(), POLL_MS);
  onCleanup(() => clearInterval(timer));
  return _$createComponent(Show, {
    get when() {
      return goal();
    },
    children: (current) => (() => {
      var _el$ = _$createElement("box"), _el$2 = _$createElement("box"), _el$3 = _$createElement("text"), _el$5 = _$createElement("text"), _el$6 = _$createElement("text");
      _$insertNode(_el$, _el$2);
      _$insertNode(_el$, _el$6);
      _$setProp(_el$, "flexDirection", "column");
      _$setProp(_el$, "gap", 0);
      _$setProp(_el$, "paddingTop", 1);
      _$insertNode(_el$2, _el$3);
      _$insertNode(_el$2, _el$5);
      _$setProp(_el$2, "flexDirection", "row");
      _$setProp(_el$2, "justifyContent", "space-between");
      _$setProp(_el$2, "gap", 1);
      _$insertNode(_el$3, _$createTextNode(`Goal`));
      _$insert(_el$5, () => `${current().status} \xB7 ${current().round}/${current().maxRounds}`);
      _$insert(_el$6, () => `  ${shorten(current().text, 34)}`);
      _$insert(_el$, _$createComponent(Show, {
        get when() {
          return _$memo(() => current().status === "paused")() && current().reason;
        },
        get children() {
          var _el$7 = _$createElement("text");
          _$insert(_el$7, () => `  ${shorten(current().reason ?? "", 34)}`);
          _$effect((_$p) => _$setProp(_el$7, "fg", theme.text.subdued, _$p));
          return _el$7;
        }
      }), null);
      _$effect((_p$) => {
        var _v$ = theme.text.default, _v$2 = TextAttributes.BOLD, _v$3 = current().status === "paused" ? theme.text.subdued : theme.text.action.primary.default, _v$4 = theme.text.default;
        _v$ !== _p$.e && (_p$.e = _$setProp(_el$3, "fg", _v$, _p$.e));
        _v$2 !== _p$.t && (_p$.t = _$setProp(_el$3, "attributes", _v$2, _p$.t));
        _v$3 !== _p$.a && (_p$.a = _$setProp(_el$5, "fg", _v$3, _p$.a));
        _v$4 !== _p$.o && (_p$.o = _$setProp(_el$6, "fg", _v$4, _p$.o));
        return _p$;
      }, {
        e: undefined,
        t: undefined,
        a: undefined,
        o: undefined
      });
      return _el$;
    })()
  });
}
function goalSidebar(context, status) {
  return context.ui.slot({
    append: "sidebar.content",
    render: (props) => _$createComponent(GoalSection, {
      context,
      get sessionID() {
        return props.sessionID;
      },
      status
    })
  });
}

// tui.ts
var tui_default = Plugin.define({
  id: "opencode-advisor.tui",
  async setup(context) {
    const advisor = context.client.rpc(Advisor);
    const features = await advisor.features({}, { location: context.location ?? context.data.location.default() }).catch(() => ({
      goal: true
    }));
    const currentSession = () => {
      const route = context.ui.router.current();
      return route.type === "session" ? route.sessionID : undefined;
    };
    const locationOf = (sessionID) => (sessionID ? context.data.session.get(sessionID)?.location : undefined) ?? context.location ?? context.data.location.default();
    const show = (title, text) => text.includes(`
`) ? context.ui.dialog.alert({ title, message: text }) : context.ui.toast.show({ title, message: text, duration: 6000 });
    const fail = (title, error) => context.ui.toast.show({ title, message: error instanceof Error ? error.message : String(error), variant: "error" });
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "advisor.model",
          title: "Set the advisor model",
          slash: { name: "advisor", arguments: true },
          run: async (input) => {
            const sessionID = currentSession();
            await advisor.advisor({ args: input ?? "" }, { location: locationOf(sessionID) }).then((reply2) => show("Advisor", reply2.text), (error) => fail("Advisor", error));
          }
        },
        ...!features.goal ? [] : [{
          id: "advisor.goal",
          title: "Work on a goal until it is done",
          slash: { name: "goal", arguments: true },
          run: async (input) => {
            const sessionID = currentSession();
            if (!sessionID)
              return void context.ui.toast.show({ title: "Goal", message: "Open a session first.", variant: "warning" });
            await advisor.goal({ sessionID, args: input ?? "" }, { location: locationOf(sessionID) }).then((reply2) => show("Goal", reply2.text), (error) => fail("Goal", error));
          }
        }]
      ]
    }));
    const stopSidebar = features.goal ? goalSidebar(context, async (sessionID) => (await advisor.goalStatus({ sessionID }, { location: locationOf(sessionID) })).goal) : () => {};
    const stopNotices = advisor.events.on("notice", (event) => {
      const { sessionID, text } = event.data;
      const title = context.data.session.get(sessionID)?.title ?? "Goal";
      context.ui.toast.show({ title, message: text, duration: 1e4 });
      context.attention.notify({ title: "OpenCode goal", message: text, notification: { when: "blurred" } });
    });
    return () => {
      stopSidebar();
      stopNotices();
    };
  }
});
export {
  tui_default as default
};
