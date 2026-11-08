import { redirect } from "next/navigation";

export default function Passed() {
  redirect("/portfolio?view=killed");
}
