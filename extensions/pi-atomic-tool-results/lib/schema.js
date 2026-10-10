const str = (description) => ({ type: "string", description });
const integer = (description, minimum, maximum, defaultValue) => ({
  type: "integer",
  description,
  minimum,
  maximum,
  ...(defaultValue === undefined ? {} : { default: defaultValue }),
});

export const RESULT_GET_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    result_ref: str("Opaque atomic conversation-result reference such as result:call_123. This is never a filesystem path."),
    selectors: {type:"array",items:{type:"string"},minItems:1,maxItems:12,description:"Retrieve several fields under one shared output budget."},
    selector_offset: integer("First selector index for multi-field pagination; use nextSelectorOffset.", 0, 12, 0),
    selector: str("Optional selector, preferably copied from the atomic result's available_paths: content, structured, details, input, meta, json, json.foo.bar, content.0.text, structured.foo, details.foo, or input.foo."),
    offset: integer("Character or array-item offset. Default 0.", 0, 100000000, 0),
    limit: integer("Maximum array items. Default 100.", 1, 1000, 100),
    max_chars: integer("Maximum characters returned to model context. Default and hard cap are controlled by the extension.", 256, 8192, 2048),
  },
  required: ["result_ref"],
};

export const RESULT_SEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    query: str("Lexical query over archived results on the active Pi branch."),
    tool: str("Optional exact tool name filter. Use tool_search to include archived discovery results, which are otherwise excluded."),
    limit: integer("Maximum matches to return.", 1, 50, 5),
  },
  required: ["query"],
};

export const RESULT_LIST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    tool: str("Optional exact tool name filter. Use tool_search to include archived discovery results, which are otherwise excluded."),
    limit: integer("Maximum recent result references.", 1, 50, 10),
  },
};
