interface JudgeSurfaceProps {
  token: string;
}

export default function JudgeSurface({ token }: JudgeSurfaceProps) {
  const hasPrivateToken = token.length > 0;

  return (
    <main className="surface surface--judge" aria-labelledby="judge-title">
      <header>
        <p>SYTYCDS / private scoring</p>
        <h1 id="judge-title">Judge scoring</h1>
      </header>
      <p>
        {hasPrivateToken
          ? "Your private judging link has been recognised."
          : "This judging link is incomplete."}
      </p>
      <output aria-label="Judge link state">Secure link ready</output>
    </main>
  );
}
