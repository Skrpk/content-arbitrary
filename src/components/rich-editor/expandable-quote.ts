import { Extension } from '@tiptap/core';

/**
 * A quotation Telegram shows collapsed — its first lines, and the rest on a
 * tap (`<blockquote expandable>`). In the editor it stays open to edit, and
 * is marked as collapsed (`data-expandable`).
 */
export const ExpandableQuote = Extension.create({
  name: 'expandableQuote',

  addGlobalAttributes() {
    return [
      {
        types: ['blockquote'],
        attributes: {
          expandable: {
            default: false,
            parseHTML: (element) => element.hasAttribute('expandable') || element.hasAttribute('data-expandable'),
            renderHTML: (attributes) => (attributes.expandable ? { 'data-expandable': '' } : {}),
          },
        },
      },
    ];
  },
});
