import { relative, sep } from 'node:path';
import { eslintCompatPlugin } from '@oxlint/plugins';

function isConstAssertion(node) {
  const type = node.typeAnnotation;
  return (
    type.type === 'TSTypeReference' &&
    type.typeName.type === 'Identifier' &&
    type.typeName.name === 'const'
  );
}

export default eslintCompatPlugin({
  meta: { name: 'project' },
  rules: {
    'require-disable-reason': {
      meta: {
        type: 'problem',
        schema: [],
        messages: {
          missing:
            'Name the disabled rules and explain the exception after --.',
          assertion:
            "List a reviewed boundary file in project/no-type-assertion's allow option instead of disabling the rule inline.",
        },
      },
      create(context) {
        return {
          Program() {
            for (const comment of context.sourceCode.getAllComments()) {
              const directive = comment.value.trim();
              if (
                !/^(?:eslint|oxlint)-disable(?:-next-line|-line)?\b/u.test(
                  directive,
                )
              ) {
                continue;
              }
              const match =
                /^(?:eslint|oxlint)-disable(?:-next-line|-line)?\s+(.+?)\s+--\s+(\S[\s\S]*)$/u.exec(
                  directive,
                );
              if (!match || !match[1].trim() || !match[2].trim()) {
                context.report({ loc: comment.loc, messageId: 'missing' });
              } else if (/\bproject\/no-type-assertion\b/u.test(match[1])) {
                context.report({ loc: comment.loc, messageId: 'assertion' });
              }
            }
          },
        };
      },
    },
    'no-type-assertion': {
      meta: {
        type: 'problem',
        defaultOptions: [{ allow: [] }],
        schema: [
          {
            type: 'object',
            properties: {
              allow: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    file: { type: 'string', minLength: 1 },
                    reason: { type: 'string', minLength: 1 },
                  },
                  required: ['file', 'reason'],
                  additionalProperties: false,
                },
              },
            },
            required: ['allow'],
            additionalProperties: false,
          },
        ],
        messages: {
          assertion:
            "Parse or narrow the value instead of asserting its type. A reviewed boundary file may be listed in this rule's allow option with a reason.",
        },
      },
      create(context) {
        const file = relative(context.cwd, context.filename)
          .split(sep)
          .join('/');
        if (context.options[0].allow.some(entry => entry.file === file))
          return {};
        const report = node => context.report({ node, messageId: 'assertion' });
        return {
          TSAsExpression(node) {
            if (!isConstAssertion(node)) report(node);
          },
          TSTypeAssertion(node) {
            if (!isConstAssertion(node)) report(node);
          },
          TSNonNullExpression: report,
          VariableDeclarator(node) {
            if (node.definite) report(node);
          },
          PropertyDefinition(node) {
            if (node.definite) report(node);
          },
        };
      },
    },
  },
});
