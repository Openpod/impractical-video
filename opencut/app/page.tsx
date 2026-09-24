import { Hero } from "@opencut/components/landing/hero";
import { Header } from "@opencut/components/header";
import { Footer } from "@opencut/components/footer";
import type { Metadata } from "next";
import { SITE_URL } from "@opencut/site/brand";

export const metadata: Metadata = {
	alternates: {
		canonical: SITE_URL,
	},
};

export default async function Home() {
	return (
		<div>
			<Header />
			<Hero />
			<Footer />
		</div>
	);
}
