// Minimal public landing page. Policy URLs are placeholders until the owner provides them (M4).
export default function Home() {
  return (
    <main className="mx-auto max-w-xl px-6 py-16 leading-relaxed">
      <h1 className="text-2xl font-semibold">Nutrition Coach</h1>
      <p className="mt-4">
        An AI nutrition coach you use over iMessage. It is an AI, not a doctor, and gives general wellness
        information only.
      </p>
      <ul className="mt-6 list-disc pl-6">
        <li>Privacy policy: coming soon</li>
        <li>Consumer health data notice: coming soon</li>
      </ul>
      <p className="mt-8 text-sm opacity-70">Nutrition data: USDA FoodData Central.</p>
    </main>
  );
}
