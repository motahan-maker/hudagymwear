import { useEffect, useState } from 'react';
import { Star, BadgeCheck, ThumbsUp, PenLine } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { sizes } from '@/lib/catalog';
import { approvedFor, averageRating, addReview, markHelpful, hasVoted, reviewEligibility, type Review } from '@/lib/reviews';

export function Stars({ value, size = 15 }: { value: number; size?: number }) {
  return <span className="stars" role="img" aria-label={`Rated ${value} out of 5 stars`}>{[1, 2, 3, 4, 5].map((i) => <Star key={i} size={size} className={i <= Math.round(value) ? 'filled' : ''} />)}</span>;
}
export function StarsInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  const [hover, setHover] = useState(0);
  return <span className="stars-input" role="radiogroup" aria-label="Your rating">{[1, 2, 3, 4, 5].map((i) => <button key={i} type="button" role="radio" aria-checked={value === i} aria-label={`${i} star${i > 1 ? 's' : ''}`} className={(hover || value) >= i ? 'lit' : ''} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(0)} onFocus={() => setHover(i)} onClick={() => onChange(i)}><Star size={26} /></button>)}</span>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function ProductReviews({ productId }: { productId: string }) {
  const [list, setList] = useState<Review[]>([]);
  const [summary, setSummary] = useState({ avg: 0, count: 0, dist: [0, 0, 0, 0, 0] });
  const [tick, setTick] = useState(0);
  const [sort, setSort] = useState<'new' | 'high' | 'helpful'>('new');
  const [verifiedOnly, setVerifiedOnly] = useState(false);
  const [formOpen, setFormOpen] = useState(false);
  const [rating, setRating] = useState(5);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [size, setSize] = useState('M');
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  useEffect(() => {
    let live = true;
    approvedFor(productId).then((rs) => { if (live) setList(rs); });
    averageRating(productId).then((s) => { if (live) setSummary(s); });
    return () => { live = false; };
  }, [productId, tick]);
  const { avg, count, dist } = summary;
  let shown = verifiedOnly ? list.filter((r) => r.verified) : list;
  if (sort === 'high') shown = [...shown].sort((a, b) => b.rating - a.rating || b.createdAt.localeCompare(a.createdAt));
  if (sort === 'helpful') shown = [...shown].sort((a, b) => b.helpful - a.helpful);
  function submit(e: React.FormEvent) {
    e.preventDefault();
    const cleanName = name.trim();
    const cleanEmail = email.trim().toLowerCase();
    if (cleanName.length < 2) { setError('Please tell us your name (2+ characters).'); return; }
    if (!EMAIL_RE.test(cleanEmail)) { setError('Please enter a valid email address.'); return; }
    if (rating < 1) { setError('Please choose a star rating.'); return; }
    if (title.trim().length < 3) { setError('Please add a short headline.'); return; }
    if (body.trim().length < 10) { setError('Please tell us a little more (10+ characters).'); return; }
    setError('');
    void reviewEligibility(productId, cleanEmail).then((elig) => {
      if (!elig.ok) { setError(elig.reason); return; }
      return addReview({ productId, author: cleanName, email: cleanEmail, rating, title: title.trim(), body: body.trim(), size, verified: false }).then(() => {
        setSent(true); setFormOpen(false); setName(''); setEmail(''); setTitle(''); setBody(''); setRating(5);
        setTick((t) => t + 1);
      }).catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not submit your review.'));
    }).catch((err: unknown) => setError(err instanceof Error ? err.message : 'Could not submit your review.'));
  }
  return <section className="section reviews-section" id="reviews"><div className="section-heading"><div><span className="eyebrow">WORN, LOVED, RATED</span><h2>Reviews{count > 0 && ` (${count})`}.</h2></div>{!formOpen && <Button variant="quiet" onClick={() => { setFormOpen(true); setSent(false); }}><PenLine size={14} /> WRITE A REVIEW</Button>}</div>
    {count > 0 ? <div className="reviews-summary"><div className="reviews-avg"><strong>{avg.toFixed(1)}</strong><Stars value={avg} size={18} /><small>Based on {count} review{count === 1 ? '' : 's'}</small></div><div className="reviews-bars">{[5, 4, 3, 2, 1].map((s) => <div key={s} className="reviews-bar-row"><span>{s}★</span><span className="bar"><span style={{ width: `${count ? Math.round((dist[s - 1]! / count) * 100) : 0}%` }} /></span><span>{dist[s - 1]}</span></div>)}</div></div> : <div className="empty-state"><h2>Be the first to review.</h2><p>Your words help her find her fit.</p></div>}
    {count > 0 && <div className="reviews-tools"><select aria-label="Sort reviews" value={sort} onChange={(e) => setSort(e.target.value as typeof sort)}><option value="new">Most recent</option><option value="high">Highest rated</option><option value="helpful">Most helpful</option></select><label className="check-line"><input type="checkbox" checked={verifiedOnly} onChange={(e) => setVerifiedOnly(e.target.checked)} /> Verified buyers only</label></div>}
    <div className="reviews-list">{shown.map((r) => <ReviewCard key={r.id} review={r} onVoted={() => setTick((t) => t + 1)} />)}</div>
    {formOpen && <form className="review-form admin-panel" onSubmit={submit}><h3>Your review</h3><label className="form-field">Name<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Your name" maxLength={60} required /></label><label className="form-field">Email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" maxLength={120} required /></label><label className="form-field">Rating<StarsInput value={rating} onChange={setRating} /></label><label className="form-field">Headline<input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Sum it up in a line" maxLength={80} /></label><label className="form-field full">Review<textarea value={body} onChange={(e) => setBody(e.target.value)} rows={4} placeholder="Fit, fabric, sizing — what should she know?" maxLength={1000} /></label><label className="form-field">Size purchased<select value={size} onChange={(e) => setSize(e.target.value)}>{sizes.map((s) => <option key={s}>{s}</option>)}</select></label>{error && <p className="field-error" role="alert">{error}</p>}<div className="admin-actions"><Button variant="quiet" type="button" onClick={() => setFormOpen(false)}>CANCEL</Button><Button variant="fashion" type="submit">SUBMIT REVIEW</Button></div></form>}
    {sent && <p className="field-ok" role="status">Thanks — your review is awaiting moderation and will appear here once approved.</p>}
  </section>;
}

function ReviewCard({ review: r, onVoted }: { review: Review; onVoted: () => void }) {
  const [voted, setVoted] = useState(hasVoted(r.id));
  return <article className="review-card"><div className="review-head"><Stars value={r.rating} /><strong>{r.title}</strong></div><p>{r.body}</p><p className="review-meta">{r.author} {r.verified && <span className="verified-tag"><BadgeCheck size={13} /> Verified buyer</span>} · Size {r.size} · {new Date(r.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</p>{r.adminReply && <div className="brand-reply"><strong>HUDA GYMWEAR responds</strong><p>{r.adminReply}</p></div>}<button type="button" className="helpful-btn" disabled={voted} onClick={() => { void markHelpful(r.id).then((ok) => { if (ok) { setVoted(true); onVoted(); } }); }}><ThumbsUp size={13} /> Helpful ({r.helpful})</button></article>;
}

/** Async rating line for cards and headers (loads approved-review aggregates). */
export function MiniStars({ productId, size = 12 }: { productId: string; size?: number }) {
  const [v, setV] = useState<{ avg: number; count: number } | null>(null);
  useEffect(() => { let live = true; averageRating(productId).then((r) => { if (live) setV({ avg: r.avg, count: r.count }); }); return () => { live = false; }; }, [productId]);
  if (!v || v.count === 0) return null;
  return <p className="mini-stars"><Stars value={v.avg} size={size} /> <span>({v.count})</span></p>;
}
