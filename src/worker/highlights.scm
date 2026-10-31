;; Refinements appended to the grammar's own highlights.scm.

[
  "if" "else" "switch" "case" "default" "for" "foreach" "while" "do" "break" "continue"
  "return" "goto" "throw" "try" "catch" "finally" "yield" "await"
] @keyword.control

["class" "struct" "interface" "enum" "record" "namespace" "delegate" "event"] @keyword.declaration

(variable_declarator name: (identifier) @variable)
(property_declaration name: (identifier) @property)
(event_declaration name: (identifier) @property)
(enum_member_declaration name: (identifier) @constant)

(object_creation_expression type: (identifier) @type)
(using_directive (identifier) @namespace)
(using_directive (qualified_name (identifier) @namespace))
(namespace_declaration name: (identifier) @namespace)
(namespace_declaration name: (qualified_name (identifier) @namespace))
(file_scoped_namespace_declaration name: (identifier) @namespace)
(file_scoped_namespace_declaration name: (qualified_name (identifier) @namespace))
(delegate_declaration name: (identifier) @type)
(record_declaration name: (identifier) @type)
(struct_declaration name: (identifier) @type)
(attribute name: (identifier) @type)
(type_parameter (identifier) @type)
(type_parameter_constraints_clause (identifier) @type)

(member_access_expression name: (identifier) @property)
(invocation_expression function: (identifier) @function)
(invocation_expression function: (generic_name (identifier) @function))
(invocation_expression (member_access_expression name: (identifier) @function))
(invocation_expression (member_access_expression name: (generic_name (identifier) @function)))

;; preproc_if and its branches enclose ordinary code, so only their tokens are captured.
["#if" "#elif" "#else" "#endif"] @preprocessor
(preproc_if condition: (_) @preprocessor)
(preproc_elif condition: (_) @preprocessor)

[
  (preproc_region)
  (preproc_endregion)
  (preproc_define)
  (preproc_undef)
  (preproc_pragma)
  (preproc_nullable)
  (preproc_error)
  (preproc_warning)
  (preproc_line)
] @preprocessor
