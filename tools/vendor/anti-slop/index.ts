import { eslintCompatPlugin } from '@oxlint/plugins';
import { noUnknownParametersRule } from './rules/no-unknown-parameters.ts';
import { noUnknownReturnsRule } from './rules/no-unknown-returns.ts';
import { noUnknownTypeAliasesRule } from './rules/no-unknown-type-aliases.ts';
import { noUnsafeDictionaryTypeRule } from './rules/no-unsafe-dictionary-type.ts';
import { noObjectParametersRule } from './rules/no-object-parameters.ts';
import { noChainedTypeAssertionsRule } from './rules/no-chained-type-assertions.ts';
import { noWidenThenAssertRule } from './rules/no-widen-then-assert.ts';
import { noKnownValueWideningRule } from './rules/no-known-value-widening.ts';
import { requireSafetyCommentForTypeAssertionRule } from './rules/require-safety-comment-for-type-assertion.ts';
import { noArrayFilterMapRule } from './rules/no-array-filter-map.ts';
import { noReduceAccumulatorCopyRule } from './rules/no-reduce-accumulator-copy.ts';
import { noReflectGetRule } from './rules/no-reflect-get.ts';
import { noReflectApplyRule } from './rules/no-reflect-apply.ts';

export default eslintCompatPlugin({
  meta: { name: 'anti-slop' },
  rules: {
    'no-unknown-parameters': noUnknownParametersRule,
    'no-unknown-returns': noUnknownReturnsRule,
    'no-unknown-type-aliases': noUnknownTypeAliasesRule,
    'no-unsafe-dictionary-type': noUnsafeDictionaryTypeRule,
    'no-object-parameters': noObjectParametersRule,
    'no-chained-type-assertions': noChainedTypeAssertionsRule,
    'no-widen-then-assert': noWidenThenAssertRule,
    'no-known-value-widening': noKnownValueWideningRule,
    'require-safety-comment-for-type-assertion': requireSafetyCommentForTypeAssertionRule,
    'no-array-filter-map': noArrayFilterMapRule,
    'no-reduce-accumulator-copy': noReduceAccumulatorCopyRule,
    'no-reflect-get': noReflectGetRule,
    'no-reflect-apply': noReflectApplyRule,
  },
});
