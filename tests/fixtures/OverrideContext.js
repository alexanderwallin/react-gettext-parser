/* eslint react/prop-types: 0 */
import React from 'react';
import { GetText, npgettext } from 'gettext-lib';

export const Comp = ({ value }) => {
  let context = 'foobar';
return (
   <div>
  <GetText
    message={'Value is: {{ value }}'}
    messagePlural={'Values are: {{ value }}'}
    scope={{ value }}
    comment={'Comment'}
    context={context}
  />
  <GetText
    message={'No context here!'}
    comment={'No context'}
  />
</div>
);
}
