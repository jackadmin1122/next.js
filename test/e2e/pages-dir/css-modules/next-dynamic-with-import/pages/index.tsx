import Link from 'next/link'
import { RedButton } from '../components/red-button'

export default function Home() {
  return (
    <>
      <Link href="/foo">/foo</Link>
      {/* RedButton should be imported to be reproduced */}
      <RedButton />
    </>
  )
}
