'use client';

import Link from 'next/link';
import { use } from 'react';
import { IssuePage } from '@jbenet/feedback-react';

/** One issue, fetched by the component from GET /api/issues/:id. The status control PATCHes it. */
export default function Issue({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  return <IssuePage id={id} Link={Link} editable />;
}
