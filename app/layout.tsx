import type { Metadata } from 'next'
import { Geist, Geist_Mono } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import 'cesium/Build/Cesium/Widgets/widgets.css'
import './globals.css'
import { AccentProvider } from '@/lib/accent-context'
import { BackgroundProvider } from '@/lib/background-context'
import { UiStyleProvider } from '@/lib/ui-style-context'
import { RouteTransition } from '@/components/route-transition'
import sunnyviewFavicon from '@/sunnyviewfavicon.svg'
import sunnyviewLogo from '@/sunnyviewlogo.svg'

const _geist = Geist({ subsets: ["latin"] });
const _geistMono = Geist_Mono({ subsets: ["latin"] });
const sunnyviewFaviconSrc = typeof sunnyviewFavicon === 'string' ? sunnyviewFavicon : sunnyviewFavicon.src
const sunnyviewLogoSrc = typeof sunnyviewLogo === 'string' ? sunnyviewLogo : sunnyviewLogo.src

export const metadata: Metadata = {
  title: 'sunnyview',
  description: 'Trace a roof, see instant solar panel layouts with energy and CO2 estimates.',
  generator: 'sunnyview',
  icons: {
    icon: [
      {
        url: sunnyviewFaviconSrc,
        type: 'image/svg+xml',
      },
    ],
    shortcut: sunnyviewFaviconSrc,
  },
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en">
      <head>
        <link rel="preload" as="image" type="image/svg+xml" href={sunnyviewLogoSrc} />
      </head>
      <body suppressHydrationWarning className={`font-sans antialiased`}>
        <BackgroundProvider>
          <AccentProvider>
            <UiStyleProvider>
              <RouteTransition>{children}</RouteTransition>
            </UiStyleProvider>
          </AccentProvider>
        </BackgroundProvider>
        <Analytics />
      </body>
    </html>
  )
}
