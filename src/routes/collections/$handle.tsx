import { createFileRoute, Navigate } from '@tanstack/react-router';
// Retired collections URLs redirect to their category equivalents so old
// links (and search engines) keep working: sculpt → Matching Sets,
// off-duty → Hoodies, new/new-in → new, best/best-sellers → best.
const REDIRECTS: Record<string, string> = {
  sculpt: 'Matching Sets',
  'off-duty': 'Hoodies',
  new: 'new',
  'new-in': 'new',
  best: 'best',
  'best-sellers': 'best',
};
export const Route = createFileRoute('/collections/$handle')({
  component: CollectionRedirect,
});
function CollectionRedirect() {
  const { handle } = Route.useParams();
  const category = REDIRECTS[handle.toLowerCase()];
  if (!category) return <Navigate to="/shop" />;
  return <Navigate to="/shop" search={{ category }} />;
}
