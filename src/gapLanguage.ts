import { StreamLanguage } from "@codemirror/language";

const KEYWORDS =
  /^(?:function|end|if|then|elif|else|fi|for|in|do|od|while|repeat|until|break|continue|return|local|global|rec|quit|QUIT)\b/;

const CONSTANTS = /^(?:true|false|fail|infinity)\b/;

const BUILTINS =
  /^(?:Declare|Install|BindGlobal|Unbind|IsBound|TryNextMethod|Assert|Info|Print|PrintTo|Read|ReadAsFunction|CallFuncList|NewFamily|NewType|Objectify|MethodsOperation|MethodsOperation)\w*/;

export const gapLanguage = StreamLanguage.define({
  token(stream) {
    if (stream.eatSpace()) return null;

    if (stream.match("#")) {
      stream.skipToEnd();
      return "comment";
    }

    if (stream.match(/^"(?:[^"\\]|\\.)*"?/)) return "string";
    if (stream.match(/^'(?:[^'\\]|\\.)*'?/)) return "string";

    if (stream.match(KEYWORDS)) return "keyword";
    if (stream.match(CONSTANTS)) return "atom";
    if (stream.match(BUILTINS)) return "builtin";

    if (stream.match(/^\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/)) return "number";

    if (
      stream.match(
        /^(?:<>|<=|>=|:=|->|\.\.|;;|[+\-*/^=<>.,;:!?()[\]{}])/
      )
    ) {
      return "operator";
    }

    if (stream.match(/^[A-Za-z_][A-Za-z0-9_]*/)) return "variableName";

    stream.next();
    return null;
  }
});
