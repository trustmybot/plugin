### Fixed
- **Insights histogram bars fill their bin** (GH 2000): each output-token histogram bar was capped at 24px, so on a wide card every bin drew a thin bar beside a wide gap. Histogram bars now span their whole bin less a 2px gap, so contiguous bins read as one distribution. Other column charts keep their 24px bars.
