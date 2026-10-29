# A small GAP tour for the IDE.
# Press F5 to run the whole file, or select a line and press Ctrl+Enter.

G := SymmetricGroup(5);;
Print("Order of S5: ", Size(G), "\n");
Print("Conjugacy classes: ", NrConjugacyClasses(G), "\n");

mySquare := function(x)
  return x^2;
end;;

Print("mySquare(12) = ", mySquare(12), "\n");

for n in [3..5] do
  Print("Factorial(", n, ") = ", Factorial(n), "\n");
od;

# The console shares the same session, so after running this file you can
# evaluate `G;` or `mySquare(7);` there.
