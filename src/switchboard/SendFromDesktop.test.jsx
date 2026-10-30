import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import SendFromDesktop, { projectOfTag } from './SendFromDesktop';

const at = (path) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/send/:runTag" element={<SendFromDesktop />} />
      </Routes>
    </MemoryRouter>
  );

test('shows the tag, its project and the desktop note', () => {
  at('/send/switchboard2-h8r-s17-c4mz');
  expect(screen.getByText('switchboard2-h8r-s17-c4mz')).toBeInTheDocument();
  expect(screen.getByText('switchboard2-h8r')).toBeInTheDocument();
  expect(screen.getByText(/only be sent from your desktop/i)).toBeInTheDocument();
  expect(screen.getByText(/Alfred extension/i)).toBeInTheDocument();
});

test('a tag it cannot read is shown without a project', () => {
  at('/send/not-a-tag');
  expect(screen.getByText('not-a-tag')).toBeInTheDocument();
  expect(screen.queryByText(/^Project/)).not.toBeInTheDocument();
});

test('projectOfTag', () => {
  expect(projectOfTag('parallel_threads-ab1-s9b-p1an')).toBe('parallel_threads-ab1');
  expect(projectOfTag('clip-7b-q4m2')).toBeNull();
});
