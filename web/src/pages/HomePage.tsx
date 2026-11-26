import { Link } from "react-router-dom";
import {
  ArrowRight,
  Bike,
  Car,
  CheckCircle2,
  Clock,
  ExternalLink,
  Headphones,
  LogIn,
  MapPin,
  ShieldCheck,
  Truck,
} from "lucide-react";
import { useAuth } from "../store/auth";
import { useDocumentTitle } from "../lib/useDocumentTitle";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DotPattern } from "@/components/ui/dot-pattern";

const SERVICES = [
  {
    title: "Car Insurance",
    badge: "Private Cars",
    icon: Car,
    accent: "bg-blue-500/10 text-blue-600 border-blue-200",
    topBar: "from-blue-600 to-indigo-600",
    description:
      "Complete protection for private cars — accident, theft, natural disaster & third-party liability cover. Fast renewal & claim assistance available.",
    highlights: ["Zero-depreciation & comprehensive cover", "Cashless garage network", "Fast renewal & claim support"],
  },
  {
    title: "Two Wheeler Insurance",
    badge: "Bikes & Scooters",
    icon: Bike,
    accent: "bg-emerald-500/10 text-emerald-600 border-emerald-200",
    topBar: "from-emerald-500 to-teal-600",
    description:
      "Affordable insurance plans for bikes & scooters — accident cover, damage protection & third-party liability with quick policy issuance & easy renewal.",
    highlights: ["Instant policy issuance", "Own-damage & third-party cover", "Hassle-free annual & multi-year renewals"],
  },
  {
    title: "Commercial Vehicle Insurance",
    badge: "Fleet & Business",
    icon: Truck,
    accent: "bg-amber-500/10 text-amber-600 border-amber-200",
    topBar: "from-amber-500 to-orange-600",
    description:
      "Tailored insurance solutions for trucks, pickups, taxis & business vehicles — vehicle damage, third-party risk & business protection cover with expert support.",
    highlights: ["Trucks, pickups, taxis & goods carriers", "Third-party & business risk cover", "Dedicated commercial claim desk"],
  },
];

export default function HomePage() {
  useDocumentTitle("Agastya Associate — Motor Insurance Agency, Udaipur");
  const { user } = useAuth();

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      {/* Top Navbar */}
      <header className="sticky top-0 z-40 border-b border-slate-200/80 bg-white/90 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2.5">
            <img
              src="/agastya_hindi_half_logo.png"
              alt="Agastya Associate"
              className="h-9 w-9 rounded-lg object-contain"
            />
            <div>
              <span className="block text-base font-bold tracking-tight text-slate-900">
                AGASTYA ASSOCIATE
              </span>
              <span className="block text-[11px] font-medium text-indigo-600">
                Motor Insurance · Udaipur
              </span>
            </div>
          </Link>

          <nav className="hidden items-center gap-6 text-sm font-medium text-slate-600 md:flex">
            <a href="#services" className="transition-colors hover:text-indigo-600">
              Services
            </a>
            <a href="#why-us" className="transition-colors hover:text-indigo-600">
              Why Agastya
            </a>
            <a href="#contact" className="transition-colors hover:text-indigo-600">
              Office & Hours
            </a>
          </nav>

          <div className="flex items-center gap-2">
            {user ? (
              <Button asChild className="bg-indigo-600 hover:bg-indigo-700 text-white">
                <Link to="/dashboard">
                  Open Dashboard
                  <ArrowRight className="ml-1.5 h-4 w-4" />
                </Link>
              </Button>
            ) : (
              <Button asChild className="bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm">
                <Link to="/login">
                  <LogIn className="mr-1.5 h-4 w-4" />
                  CRM Login
                </Link>
              </Button>
            )}
          </div>
        </div>
      </header>

      {/* Hero Section */}
      <section className="relative overflow-hidden bg-gradient-to-br from-slate-950 via-indigo-950 to-blue-900 py-16 text-white sm:py-24">
        <DotPattern
          className="opacity-25 [mask-image:radial-gradient(600px_circle_at_center,white,transparent)] text-indigo-300"
        />
        <div className="pointer-events-none absolute -left-24 -top-24 h-80 w-80 rounded-full bg-blue-500/20 blur-3xl" />
        <div className="pointer-events-none absolute -bottom-24 -right-24 h-80 w-80 rounded-full bg-emerald-500/20 blur-3xl" />

        <div className="relative mx-auto max-w-6xl px-4 sm:px-6">
          <div className="max-w-3xl space-y-6">
            <div className="inline-flex items-center rounded-full border border-emerald-400/30 bg-emerald-500/15 px-3.5 py-1 backdrop-blur-sm">
              <ShieldCheck className="mr-2 h-4 w-4 text-emerald-300" />
              <span className="text-xs font-semibold tracking-wide text-emerald-100">
                Motor Insurance Agency · Panchwati, Udaipur
              </span>
            </div>

            <h1 className="text-3xl font-extrabold tracking-tight text-white sm:text-5xl sm:leading-[1.12]">
              Complete protection for your vehicles with{" "}
              <span className="bg-gradient-to-r from-sky-400 via-emerald-300 to-teal-300 bg-clip-text text-transparent">
                fast policy service &amp; claim support.
              </span>
            </h1>

            <p className="max-w-2xl text-base leading-relaxed text-slate-300 sm:text-lg">
              Trusted motor insurance solutions for private cars, two-wheelers, and
              commercial vehicles in Udaipur, Rajasthan. Quick issuance, transparent
              renewals, and 24-hour assistance when you need it most.
            </p>

            <div className="flex flex-wrap items-center gap-3 pt-2">
              <Button
                asChild
                size="lg"
                className="bg-emerald-500 text-slate-950 font-semibold hover:bg-emerald-400"
              >
                <Link to={user ? "/dashboard" : "/login"}>
                  {user ? "Go to CRM Dashboard" : "Staff & Partner Login"}
                  <ArrowRight className="ml-2 h-4 w-4" />
                </Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="border-white/25 bg-white/5 text-white hover:bg-white/15 hover:text-white"
              >
                <a href="#services">Explore Insurance Plans</a>
              </Button>
            </div>

            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 pt-4 text-xs text-slate-300 sm:text-sm">
              <span className="inline-flex items-center gap-1.5">
                <Clock className="h-4 w-4 text-emerald-400" />
                Open 24 Hours (Mon–Sun)
              </span>
              <span className="inline-flex items-center gap-1.5">
                <MapPin className="h-4 w-4 text-sky-400" />
                Panchwati, Udaipur 313004
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Headphones className="h-4 w-4 text-amber-400" />
                Fast Claim &amp; Renewal Support
              </span>
            </div>
          </div>
        </div>
      </section>

      {/* Services Section */}
      <section id="services" className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-18">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <Badge className="mb-2 bg-indigo-100 text-indigo-700 hover:bg-indigo-100">
              Our Core Services
            </Badge>
            <h2 className="text-2xl font-bold tracking-tight text-slate-900 sm:text-3xl">
              Motor Insurance Tailored to Every Need
            </h2>
            <p className="mt-1.5 text-sm text-slate-600">
              Comprehensive coverage, third-party protection, and rapid claim guidance.
            </p>
          </div>
        </div>

        <div className="grid gap-5 md:grid-cols-3">
          {SERVICES.map((svc) => {
            const IconComp = svc.icon;
            return (
              <Card
                key={svc.title}
                className="group relative overflow-hidden border-slate-200 bg-white transition-all hover:-translate-y-0.5 hover:border-indigo-300"
              >
                <div className={`h-1.5 w-full bg-gradient-to-r ${svc.topBar}`} />
                <CardContent className="p-6 space-y-4">
                  <div className="flex items-center justify-between">
                    <div
                      className={`flex h-11 w-11 items-center justify-center rounded-xl border ${svc.accent}`}
                    >
                      <IconComp className="h-5 w-5" />
                    </div>
                    <Badge variant="secondary" className="text-[11px] font-medium">
                      {svc.badge}
                    </Badge>
                  </div>

                  <div>
                    <h3 className="text-lg font-bold text-slate-900">{svc.title}</h3>
                    <p className="mt-1.5 text-sm leading-relaxed text-slate-600">
                      {svc.description}
                    </p>
                  </div>

                  <ul className="space-y-1.5 border-t border-slate-100 pt-3">
                    {svc.highlights.map((item) => (
                      <li
                        key={item}
                        className="flex items-center gap-2 text-xs text-slate-700"
                      >
                        <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-600" />
                        <span>{item}</span>
                      </li>
                    ))}
                  </ul>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      {/* Why Agastya & Office Location */}
      <section id="why-us" className="border-y border-slate-200 bg-white py-14">
        <div className="mx-auto grid max-w-6xl gap-8 px-4 sm:px-6 lg:grid-cols-12">
          <div className="space-y-4 lg:col-span-6">
            <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">
              Why Choose Agastya Associate
            </Badge>
            <h2 className="text-2xl font-bold tracking-tight text-slate-900">
              Reliable Service from Policy Issuance to Claim Settlement
            </h2>
            <p className="text-sm leading-relaxed text-slate-600">
              Whether you are insuring a new family car, renewing a daily scooter, or
              managing a commercial fleet of trucks and taxis, we make insurance simple,
              transparent, and always reachable.
            </p>
            <div className="grid gap-3 pt-2 sm:grid-cols-2">
              <div className="rounded-lg border border-blue-100 bg-blue-50/60 p-3.5">
                <p className="text-sm font-semibold text-blue-950">Quick Issuance</p>
                <p className="mt-1 text-xs text-blue-800/80">
                  Fast quote comparisons and instant digital policy copies.
                </p>
              </div>
              <div className="rounded-lg border border-emerald-100 bg-emerald-50/60 p-3.5">
                <p className="text-sm font-semibold text-emerald-950">Easy Renewals</p>
                <p className="mt-1 text-xs text-emerald-800/80">
                  Timely reminders so your coverage never lapses.
                </p>
              </div>
              <div className="rounded-lg border border-amber-100 bg-amber-50/60 p-3.5">
                <p className="text-sm font-semibold text-amber-950">Claim Assistance</p>
                <p className="mt-1 text-xs text-amber-800/80">
                  Step-by-step guidance during accidents or damage claims.
                </p>
              </div>
              <div className="rounded-lg border border-indigo-100 bg-indigo-50/60 p-3.5">
                <p className="text-sm font-semibold text-indigo-950">24-Hour Support</p>
                <p className="mt-1 text-xs text-indigo-800/80">
                  Open 24 hours every day for urgent policy &amp; road support.
                </p>
              </div>
            </div>
          </div>

          <div id="contact" className="lg:col-span-6">
            <Card className="h-full overflow-hidden border-indigo-200 bg-gradient-to-br from-indigo-50/70 via-white to-sky-50/60">
              <CardContent className="flex h-full flex-col justify-between p-6 space-y-5">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <h3 className="text-lg font-bold text-slate-900">
                      Visit Our Udaipur Office
                    </h3>
                    <Badge className="bg-emerald-600 text-white hover:bg-emerald-600">
                      Open 24 Hours
                    </Badge>
                  </div>

                  <div className="space-y-3 text-sm text-slate-700">
                    <div className="flex items-start gap-3">
                      <MapPin className="mt-0.5 h-4 w-4 shrink-0 text-indigo-600" />
                      <div>
                        <p className="font-semibold text-slate-900">AGASTYA ASSOCIATE</p>
                        <p className="text-slate-600">
                          10-A, Road number 5, opposite Sachin Motors,
                          <br />
                          behind Saheli Palace, Panchwati,
                          <br />
                          Udaipur, Rajasthan 313004
                        </p>
                      </div>
                    </div>

                    <div className="flex items-start gap-3">
                      <Clock className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                      <div>
                        <p className="font-semibold text-slate-900">Business Hours</p>
                        <p className="text-slate-600">
                          Monday – Sunday: Open 24 hours
                        </p>
                      </div>
                    </div>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2.5 border-t border-slate-200/80 pt-4">
                  <Button asChild variant="outline" size="sm" className="bg-white">
                    <a
                      href="https://share.google/Q8s7ARJD5EV4yWC8E"
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      View on Google Maps
                      <ExternalLink className="ml-1.5 h-3.5 w-3.5" />
                    </a>
                  </Button>
                  <Button asChild size="sm" className="bg-indigo-600 hover:bg-indigo-700 text-white">
                    <Link to={user ? "/dashboard" : "/login"}>
                      {user ? "Open CRM" : "Partner / Staff Login"}
                    </Link>
                  </Button>
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="bg-slate-950 py-8 text-slate-400">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-4 px-4 text-xs sm:px-6">
          <div className="flex items-center gap-2">
            <img
              src="/agastya_hindi_half_logo.png"
              alt="Agastya Associate"
              className="h-6 w-6 rounded object-contain"
            />
            <span className="font-semibold text-slate-200">AGASTYA ASSOCIATE</span>
            <span>· Panchwati, Udaipur, Rajasthan</span>
          </div>
          <div className="flex items-center gap-4">
            <Link to="/login" className="text-slate-300 hover:text-white">
              CRM Portal Login
            </Link>
            <span>© {new Date().getFullYear()} Agastya Associate</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
