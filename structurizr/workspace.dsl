workspace "Sunnyview" "Rooftop solar feasibility demo (SF Hacks 2026)." {

    model {
        user = person "Homeowner" "Traces a roof and gets quick panel, energy, and CO2 estimates. Saves history and projects."
        recipient = person "Share recipient" "Opens a public, read-only share link for a saved project."

        sunnyview = softwareSystem "Sunnyview" "Fast rooftop solar feasibility demo." "Internal" {
            web = container "Web Client" "Search + trace roof polygon; runs deterministic panel packing locally in the browser. Includes the /s/[shareSlug] share page." "Next.js (React in browser)" "Web"
            api = container "API / BFF" "Next.js route handlers that proxy external APIs, persist history and projects, serve share snapshots, rate limit, cache, and hide keys." "Next.js Route Handlers (Node.js)" "API"
            segmenter = container "CV Segmenter" "Optional auto-outline service (roof + obstacles) for /api/segment. Separate Python service." "Python (FastAPI)" "ML,Optional"
            mongo = container "MongoDB" "Optional persistence: per-visitor history (history_entries) and owned projects with share slugs (projects)." "MongoDB" "Database,Optional"
            redis = container "Upstash Redis" "Optional cache for PVWatts estimates (24h)." "Upstash Redis" "Cache,Optional"
        }

        geoApis = softwareSystem "Geospatial APIs (ArcGIS, Nominatim, OSM Overpass)" "Geocoding (ArcGIS, then Nominatim), satellite imagery (ArcGIS), and building footprints (Overpass mirrors)." "External"
        mapbox = softwareSystem "Mapbox Static Images" "Optional fallback satellite imagery for /api/static-map." "External,Optional"
        solarWeatherApis = softwareSystem "Solar + Weather APIs (PVWatts + Open-Meteo)" "Energy yield (PVWatts) and forecast/archive (Open-Meteo) used by estimates and panel recommendations." "External"
        aiVoiceApis = softwareSystem "AI + Voice APIs (Gemini + ElevenLabs)" "Optional panel recommendations (Gemini) and narration (ElevenLabs)." "External,Optional"

        user -> web "Traces roofs and reviews estimates"
        recipient -> web "Opens share link"

        web -> api "Calls /api/* routes"

        api -> geoApis "Geocoding, imagery, footprints"
        api -> segmenter "Forwards outline requests (when configured)" {
            tags "Optional"
        }

        api -> mapbox "Static-map fallback" {
            tags "Optional"
        }

        api -> solarWeatherApis "Energy yield and weather data"
        api -> aiVoiceApis "Recommendations and narration" {
            tags "Optional"
        }

        api -> mongo "Reads and writes history and projects" {
            tags "Optional"
        }

        api -> redis "Caches estimates" {
            tags "Optional"
        }
    }

    views {
        branding {
            font "Space Grotesk" "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600&display=swap"
        }

        container sunnyview "general-architecture" {
            title "SUNNYVIEW / GENERAL ARCHITECTURE"
            include *
            autolayout tb 220 170
        }

        container sunnyview "main-feature" {
            title "SUNNYVIEW / MAIN FEATURE: TRACE ROOF -> ESTIMATE"
            include user
            include web
            include api
            include segmenter
            include mongo
            include redis
            include geoApis
            include mapbox
            include solarWeatherApis
            include aiVoiceApis
            autolayout lr 240 180
        }

        styles {
            element "Element" {
                shape RoundedBox
                background #0B1220
                color #E2E8F0
                stroke #334155
                strokeWidth 2
                fontSize 36
                description false
                metadata false
            }

            element "Boundary" {
                background #05060A
                color #05060A
                stroke #05060A
                strokeWidth 1
            }

            element "Boundary:Software System" {
                background #05060A
                color #05060A
                stroke #05060A
                strokeWidth 1
            }

            element "Boundary:Container" {
                background #05060A
                color #05060A
                stroke #05060A
                strokeWidth 1
            }

            element "Group" {
                background #05060A
                color #05060A
                stroke #05060A
                strokeWidth 1
                border Dashed
            }

            element "Person" {
                shape RoundedBox
                background #0B1220
                color #F8FAFC
                stroke #38BDF8
                strokeWidth 3
            }

            element "Web" {
                shape WebBrowser
                background #0B1220
                color #F8FAFC
                stroke #38BDF8
                strokeWidth 3
            }

            element "API" {
                shape Hexagon
                background #0B1220
                color #F8FAFC
                stroke #38BDF8
                strokeWidth 3
            }

            element "ML" {
                shape RoundedBox
                background #0B1220
                color #F8FAFC
                stroke #F59E0B
                strokeWidth 3
                border Dashed
            }

            element "Database" {
                shape Cylinder
                background #0B1220
                color #F8FAFC
                stroke #F59E0B
                strokeWidth 3
            }

            element "Cache" {
                shape Cylinder
                background #0B1220
                color #F8FAFC
                stroke #F59E0B
                strokeWidth 3
            }

            element "External" {
                background #0B1220
                color #CBD5E1
                stroke #64748B
                strokeWidth 2
                border Dashed
            }

            element "Optional" {
                opacity 78
                stroke #F59E0B
                strokeWidth 3
                border Dashed
            }

            relationship "Relationship" {
                thickness 5
                color #94A3B8
                routing Direct
                fontSize 16
            }

            relationship "Optional" {
                style Dashed
                color #64748B
            }
        }
    }
}
