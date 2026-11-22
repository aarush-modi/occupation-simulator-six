import assert from 'node:assert/strict';
import test from 'node:test';
import { articleFor } from '../app/ui/promptSentence.js';

test('the sentence picks "a" or "an" for the job typed', () => {
  assert.equal(articleFor('barista'), 'a');
  assert.equal(articleFor('astronaut'), 'an');
  assert.equal(articleFor('Electrician'), 'an');
  assert.equal(articleFor('hour-long tour guide'), 'an');
  assert.equal(articleFor('university lecturer'), 'a');
  assert.equal(articleFor('MRI technician'), 'an');
  assert.equal(articleFor('a nurse on nights'), '', 'already has an article');
  assert.equal(articleFor('the head chef'), '');
});
